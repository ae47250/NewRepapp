import { interpretQuery, findCountryByCode, hasPhrase, normalizeText } from "./interpret-query.js";

export const config = {
  maxDuration: 30
};

const EIA_BASE_URL = "https://api.eia.gov/v2/international";
const DEFAULT_FREQUENCY = "annual";
const MAX_BROAD_ROWS = 1500;
const MAX_SERIES_ROWS = 1500;
const VARIABLE_LIMIT = 5;
const CACHE_TTL_MS = 10 * 60 * 1000;
const COUNTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ITEMS = 150;

const cache = globalThis.__EIA_APP_CACHE__ || new Map();
globalThis.__EIA_APP_CACHE__ = cache;

export default async function handler(req, res) {
  setJsonHeaders(res);

  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed.",
      userMessage: "Use a GET request for this API route."
    });
  }

  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Missing EIA_API_KEY environment variable in Vercel.",
      userMessage: "The EIA API key is missing in Vercel. Add EIA_API_KEY in Vercel Environment Variables and redeploy."
    });
  }

  const query = cleanString(req.query.q);
  const modeOverride = cleanString(req.query.mode).toLowerCase();
  const productId = cleanString(req.query.productId);
  const activityId = cleanString(req.query.activityId);
  const unit = cleanString(req.query.unit);
  const explicitCountry = cleanString(req.query.country);
  const explicitCountries = cleanString(req.query.countries);

  try {
    const countries = await getEiaCountries(apiKey);
    const countrySelection = resolveCountrySelection({ query, explicitCountry, explicitCountries, countries });
    const intent = interpretQuery(query || countrySelection.queryForIntent || "", countries);
    const mergedIntent = mergeIntentWithExplicitCountries(intent, countrySelection.countries);
    const frequency = sanitizeFrequency(req.query.frequency || mergedIntent.frequency || DEFAULT_FREQUENCY);

    if (countrySelection.countries.length === 0) {
      return res.status(200).json({
        query,
        needsCountry: true,
        intent: mergedIntent,
        userMessage: "Please include at least one country. Examples: Brazil energy consumption; compare Canada and Mexico natural gas production."
      });
    }

    const wantsComparison = modeOverride === "comparison" || (modeOverride !== "single" && countrySelection.countries.length > 1) || mergedIntent.comparison;

    if (productId && activityId && unit) {
      if (wantsComparison && countrySelection.countries.length > 1) {
        const comparisonPayload = await buildExplicitComparison({ apiKey, countries: countrySelection.countries, productId, activityId, unit, frequency, query, intent: mergedIntent });
        return res.status(200).json(comparisonPayload);
      }

      const selectedSeries = await fetchExactSeries({
        apiKey,
        country: countrySelection.countries[0],
        productId,
        activityId,
        unit,
        frequency
      });

      return res.status(200).json({
        query,
        mode: "single",
        intent: mergedIntent,
        source: "U.S. Energy Information Administration API, International Energy Statistics",
        selectedSeries,
        variables: [],
        note: "Coverage is computed from actual observations returned for the selected EIA series."
      });
    }

    if (wantsComparison && countrySelection.countries.length > 1) {
      const comparisonPayload = await buildComparisonFromQuery({
        apiKey,
        countries: countrySelection.countries,
        query,
        intent: mergedIntent,
        frequency
      });
      return res.status(200).json(comparisonPayload);
    }

    const singlePayload = await buildSingleCountrySearch({
      apiKey,
      country: countrySelection.countries[0],
      query,
      intent: mergedIntent,
      frequency
    });

    return res.status(200).json(singlePayload);
  } catch (error) {
    return res.status(500).json({
      error: "Server error while contacting EIA API.",
      userMessage: friendlyErrorMessage(error),
      details: hideApiKey(error.message, apiKey)
    });
  }
}

async function buildSingleCountrySearch({ apiKey, country, query, intent, frequency }) {
  const broadRows = await fetchCountryRows({ apiKey, countryCode: country.code, frequency });

  if (broadRows.length === 0) {
    return {
      query,
      mode: "single",
      country,
      intent,
      selectedSeries: null,
      variables: [],
      userMessage: `EIA returned no international ${frequency} rows for ${country.name}.`
    };
  }

  const rawCandidates = buildCandidateVariables(broadRows, intent, query);

  if (rawCandidates.length === 0) {
    return {
      query,
      mode: "single",
      country,
      intent,
      selectedSeries: null,
      variables: [],
      userMessage: "EIA returned rows, but no usable numeric series were found."
    };
  }

  const enrichedCandidates = await enrichCandidates({
    apiKey,
    country,
    candidates: rawCandidates.slice(0, VARIABLE_LIMIT),
    frequency
  });

  const selectedSeries = enrichedCandidates[0]?.series || null;

  return {
    query,
    mode: "single",
    country,
    intent,
    source: "U.S. Energy Information Administration API, International Energy Statistics",
    selectedSeries,
    variables: enrichedCandidates.map(item => item.variable),
    note: "Coverage is computed from actual observations for each displayed series, not from the partial search list."
  };
}

async function buildComparisonFromQuery({ apiKey, countries, query, intent, frequency }) {
  const primaryPayload = await buildSingleCountrySearch({
    apiKey,
    country: countries[0],
    query,
    intent,
    frequency
  });

  if (!primaryPayload.selectedSeries) {
    return {
      ...primaryPayload,
      mode: "comparison",
      series: [],
      userMessage: "No usable primary series was found, so the comparison could not be created."
    };
  }

  return buildExplicitComparison({
    apiKey,
    countries,
    productId: primaryPayload.selectedSeries.productId,
    activityId: primaryPayload.selectedSeries.activityId,
    unit: primaryPayload.selectedSeries.unitFacet,
    frequency,
    query,
    intent,
    variables: primaryPayload.variables
  });
}

async function buildExplicitComparison({ apiKey, countries, productId, activityId, unit, frequency, query, intent, variables = [] }) {
  const settled = await Promise.allSettled(
    countries.map(country => fetchExactSeries({ apiKey, country, productId, activityId, unit, frequency }))
  );

  const series = settled
    .map((result, index) => {
      if (result.status === "fulfilled") return result.value;
      return {
        country: countries[index].name,
        countryCode: countries[index].code,
        productId,
        activityId,
        unitFacet: unit,
        title: "Series unavailable",
        points: [],
        coverage: null,
        unavailableReason: result.reason?.message || "No data returned."
      };
    })
    .filter(item => Array.isArray(item.points) && item.points.length > 0);

  const firstSeries = series[0] || null;

  return {
    query,
    mode: "comparison",
    comparison: true,
    intent,
    source: "U.S. Energy Information Administration API, International Energy Statistics",
    selectedVariable: firstSeries ? {
      title: firstSeries.title,
      product: firstSeries.product,
      activity: firstSeries.activity,
      productId: firstSeries.productId,
      activityId: firstSeries.activityId,
      unit: firstSeries.unit,
      unitFacet: firstSeries.unitFacet
    } : null,
    series,
    variables,
    note: "Comparison mode uses the same EIA product, activity, and unit across countries whenever available.",
    userMessage: series.length === 0 ? "No comparable numeric observations were found for the requested countries." : null
  };
}

async function fetchCountryRows({ apiKey, countryCode, frequency }) {
  const url = buildEiaDataUrl(apiKey, {
    countryCode,
    frequency,
    length: MAX_BROAD_ROWS
  });
  const json = await fetchJsonCached(url, CACHE_TTL_MS, apiKey);
  return Array.isArray(json?.response?.data) ? json.response.data : [];
}

async function fetchExactSeries({ apiKey, country, productId, activityId, unit, frequency }) {
  const url = buildEiaDataUrl(apiKey, {
    countryCode: country.code,
    productId,
    activityId,
    unit,
    frequency,
    length: MAX_SERIES_ROWS
  });

  const json = await fetchJsonCached(url, CACHE_TTL_MS, apiKey);
  const rows = Array.isArray(json?.response?.data) ? json.response.data : [];
  const points = cleanDataRows(rows).reverse();

  if (points.length === 0) {
    throw new Error(`No numeric observations found for ${country.name}.`);
  }

  const sample = rows.find(row => Number.isFinite(toNumber(row.value))) || rows[0] || {};
  const product = cleanString(sample.productName || sample.product || productId);
  const activity = cleanString(sample.activityName || sample.activity || activityId);
  const displayUnit = cleanString(sample.unitName || sample["value-units"] || sample.unit || unit);
  const coverage = coverageFromPoints(points);
  const latest = points[points.length - 1];

  return {
    id: `${country.code}|${productId}|${activityId}|${unit}`,
    title: `${product} — ${activity}`,
    product,
    activity,
    productId: cleanString(productId),
    activityId: cleanString(activityId),
    unit: displayUnit,
    unitFacet: cleanString(unit),
    country: country.name,
    countryCode: country.code,
    frequency,
    coverage,
    latestPeriod: latest?.period || "",
    latestValue: latest?.value ?? null,
    points,
    chartPoints: points.slice(-20)
  };
}

async function enrichCandidates({ apiKey, country, candidates, frequency }) {
  const settled = await Promise.allSettled(
    candidates.map(async candidate => {
      const series = await fetchExactSeries({
        apiKey,
        country,
        productId: candidate.productId,
        activityId: candidate.activityId,
        unit: candidate.unitFacet,
        frequency
      });

      const variable = {
        label: series.title,
        product: series.product,
        activity: series.activity,
        productId: series.productId,
        activityId: series.activityId,
        unit: series.unit,
        unitFacet: series.unitFacet,
        country: series.country,
        countryCode: series.countryCode,
        frequency: series.frequency,
        coverage: formatCoverage(series.coverage),
        coverageStart: series.coverage?.start || "",
        coverageEnd: series.coverage?.end || "",
        observationsFound: series.coverage?.count || 0,
        latestPeriod: series.latestPeriod,
        latestValue: series.latestValue,
        matchScore: candidate.score
      };

      return { variable, series, score: candidate.score };
    })
  );

  const enriched = settled
    .filter(result => result.status === "fulfilled" && result.value)
    .map(result => result.value);

  return enriched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.variable.observationsFound || 0) - (a.variable.observationsFound || 0);
  });
}

function buildCandidateVariables(rows, intent, query) {
  const groups = new Map();

  for (const row of rows) {
    const value = toNumber(row.value);
    if (!row.period || !Number.isFinite(value)) continue;

    const productId = cleanString(row.productId);
    const productName = cleanString(row.productName || row.product || productId);
    const activityId = cleanString(row.activityId);
    const activityName = cleanString(row.activityName || row.activity || activityId);
    const unitFacet = cleanString(row.unit);
    const unit = cleanString(row.unitName || row["value-units"] || row.unit);

    if (!productId || !activityId || !unitFacet) continue;

    const key = `${productId}|${activityId}|${unitFacet}`;

    if (!groups.has(key)) {
      groups.set(key, {
        productId,
        productName,
        activityId,
        activityName,
        unit,
        unitFacet,
        rows: []
      });
    }

    groups.get(key).rows.push({
      period: cleanString(row.period),
      value
    });
  }

  const candidates = [];

  for (const group of groups.values()) {
    const cleanRows = uniquePeriods(group.rows).sort((a, b) => comparePeriodsDesc(a.period, b.period));
    if (cleanRows.length === 0) continue;

    const score = scoreVariable(group, intent, query) + Math.min(cleanRows.length, 40) * 0.3;

    candidates.push({
      ...group,
      label: `${group.productName} — ${group.activityName}`,
      latestPeriod: cleanRows[0].period,
      latestValue: cleanRows[0].value,
      observationsFound: cleanRows.length,
      score
    });
  }

  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.observationsFound !== a.observationsFound) return b.observationsFound - a.observationsFound;
    return String(a.label).localeCompare(String(b.label));
  });
}

function scoreVariable(group, intent, query) {
  const q = normalizeText(query);
  const product = normalizeText(group.productName);
  const activity = normalizeText(group.activityName);
  const unit = normalizeText(group.unit);
  const text = `${product} ${activity} ${unit}`;
  let score = 0;

  if (intent.activity && activity.includes(intent.activity)) score += 85;
  if (intent.product && product.includes(intent.product)) score += 85;

  if (intent.product === "petroleum" && (product.includes("petroleum") || product.includes("oil") || product.includes("liquid"))) score += 45;
  if (intent.product === "renewable" && (product.includes("renewable") || product.includes("hydro") || product.includes("solar") || product.includes("wind"))) score += 35;
  if (intent.product === "total energy" && product.includes("total energy")) score += 45;

  if (q.includes("energy consumption") && product.includes("total energy") && activity.includes("consumption")) score += 110;
  if (q.includes("electricity generation") && product.includes("electricity") && activity.includes("generation")) score += 110;
  if (q.includes("natural gas production") && product.includes("natural gas") && activity.includes("production")) score += 110;
  if (q.includes("natural gas consumption") && product.includes("natural gas") && activity.includes("consumption")) score += 110;
  if (q.includes("oil consumption") && (product.includes("petroleum") || product.includes("oil")) && activity.includes("consumption")) score += 110;
  if (q.includes("oil production") && (product.includes("petroleum") || product.includes("oil")) && activity.includes("production")) score += 110;

  for (const word of `${q} ${intent.cleanedKeywords || ""}`.split(" ")) {
    if (word.length > 3 && text.includes(word)) score += 5;
  }

  if (activity.includes("consumption")) score += 4;
  if (product.includes("total energy")) score += 3;
  if (unit.includes("percent")) score -= 8;

  return score;
}

async function getEiaCountries(apiKey) {
  const url = `${EIA_BASE_URL}/facet/countryRegionId/?api_key=${encodeURIComponent(apiKey)}`;
  const json = await fetchJsonCached(url, COUNTRY_CACHE_TTL_MS, apiKey);
  const facets = Array.isArray(json?.response?.facets) ? json.response.facets : [];

  return facets
    .filter(item => item && item.id && item.name)
    .map(item => ({
      code: cleanString(item.id).toUpperCase(),
      name: cleanString(item.name),
      alias: cleanString(item.alias || "")
    }));
}

function resolveCountrySelection({ query, explicitCountry, explicitCountries, countries }) {
  const selected = new Map();
  const queryForIntent = [query, explicitCountry, explicitCountries].filter(Boolean).join(" ");

  const addCountry = value => {
    const item = resolveCountry(value, countries);
    if (item) selected.set(item.code, item);
  };

  if (explicitCountries) {
    explicitCountries.split(",").map(item => item.trim()).filter(Boolean).forEach(addCountry);
  }

  if (explicitCountry) addCountry(explicitCountry);

  const intentCountries = interpretQuery(queryForIntent || query || "", countries).countries;
  for (const country of intentCountries) selected.set(country.code, country);

  return {
    countries: Array.from(selected.values()),
    queryForIntent
  };
}

function resolveCountry(value, countries) {
  const raw = cleanString(value);
  if (!raw) return null;

  const byCode = findCountryByCode(countries, raw);
  if (byCode) return byCode;

  const normalized = normalizeText(raw);
  return countries.find(country => normalizeText(country.name) === normalized || hasPhrase(normalized, normalizeText(country.name))) || null;
}

function mergeIntentWithExplicitCountries(intent, countries) {
  return {
    ...intent,
    countries,
    countryCodes: countries.map(country => country.code),
    primaryCountry: countries[0] || null,
    comparison: countries.length > 1 || intent.comparison,
    mode: countries.length > 1 || intent.comparison ? "comparison" : "single"
  };
}

function buildEiaDataUrl(apiKey, options) {
  const params = new URLSearchParams();

  params.set("api_key", apiKey);
  params.set("frequency", sanitizeFrequency(options.frequency || DEFAULT_FREQUENCY));
  params.append("data[0]", "value");
  params.append("facets[countryRegionId][]", options.countryCode);

  if (options.productId) params.append("facets[productId][]", String(options.productId));
  if (options.activityId) params.append("facets[activityId][]", String(options.activityId));
  if (options.unit) params.append("facets[unit][]", String(options.unit));

  params.set("sort[0][column]", "period");
  params.set("sort[0][direction]", "desc");
  params.set("offset", "0");
  params.set("length", String(options.length || MAX_BROAD_ROWS));

  return `${EIA_BASE_URL}/data/?${params.toString()}`;
}

async function fetchJsonCached(url, ttlMs, apiKey) {
  const now = Date.now();
  const cached = cache.get(url);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const value = await fetchJson(url, apiKey);
  pruneCache();
  cache.set(url, { value, expiresAt: now + ttlMs });
  return value;
}

async function fetchJson(url, apiKey) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let json;

    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`EIA returned a non-JSON response: ${text.slice(0, 180)}`);
    }

    if (!response.ok) {
      const message = json?.error || json?.message || `HTTP ${response.status}`;
      throw new Error(`EIA request failed: ${message}`);
    }

    if (json?.error) {
      throw new Error(`EIA returned an error: ${json.error}`);
    }

    return json;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("The EIA API request timed out. Try a narrower search.");
    }
    throw new Error(hideApiKey(error.message, apiKey));
  } finally {
    clearTimeout(timeout);
  }
}

function cleanDataRows(rows) {
  return uniquePeriods(
    rows
      .map(row => ({
        period: cleanString(row.period),
        value: toNumber(row.value)
      }))
      .filter(row => row.period && Number.isFinite(row.value))
  ).sort((a, b) => comparePeriodsDesc(a.period, b.period));
}

function uniquePeriods(rows) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    if (seen.has(row.period)) continue;
    seen.add(row.period);
    output.push(row);
  }

  return output;
}

function coverageFromPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  const sorted = [...points].sort((a, b) => comparePeriodsAsc(a.period, b.period));
  return {
    start: sorted[0].period,
    end: sorted[sorted.length - 1].period,
    count: sorted.length
  };
}

function formatCoverage(coverage) {
  if (!coverage) return "Not availab
