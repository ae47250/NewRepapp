import { interpretQuery, findCountryByCode, hasPhrase, normalizeText } from "./interpret-query.js";

const EIA_BASE_URL = "https://api.eia.gov/v2/international";
const DEFAULT_FREQUENCY = "annual";
const MAX_BROAD_ROWS = 5000;
const MAX_SERIES_ROWS = 5000;
const VARIABLE_LIMIT = 15;
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
  const enriched = [];

  for (const candidate of candidates) {
    try {
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

      enriched.push({ variable, series, score: candidate.score });
    } catch {
      // Skip exact-detail failures so one bad EIA series does not break the whole result set.
    }
  }

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
  if (!coverage) return "Not available";
  if (coverage.start === coverage.end) return `${coverage.start} (${coverage.count} obs.)`;
  return `${coverage.start}–${coverage.end} (${coverage.count} obs.)`;
}

function comparePeriodsAsc(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function comparePeriodsDesc(a, b) {
  return String(b).localeCompare(String(a), undefined, { numeric: true });
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(String(value).replace(/,/g, ""));
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function sanitizeFrequency(value) {
  const frequency = cleanString(value).toLowerCase();
  if (["annual", "monthly", "quarterly"].includes(frequency)) return frequency;
  return DEFAULT_FREQUENCY;
}

function pruneCache() {
  if (cache.size < MAX_CACHE_ITEMS) return;
  const now = Date.now();

  for (const [key, item] of cache.entries()) {
    if (item.expiresAt <= now) cache.delete(key);
  }

  while (cache.size >= MAX_CACHE_ITEMS) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

function setJsonHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
}

function friendlyErrorMessage(error) {
  const message = String(error?.message || "");
  if (message.includes("Missing EIA_API_KEY")) return "The EIA key is missing in Vercel Environment Variables.";
  if (message.includes("timed out")) return "The EIA request timed out. Try a narrower search or fewer countries.";
  if (message.includes("Invalid frequency")) return "That frequency is not available for this EIA route. Try annual data.";
  if (message.includes("404")) return "The EIA route was not found. Check that this app is using the /v2/international/data/ route.";
  return "The EIA API request failed. Try a simpler search such as Brazil energy consumption.";
}

function hideApiKey(value, apiKey) {
  const text = String(value || "");
  if (!apiKey) return text;
  return text
    .replaceAll(encodeURIComponent(apiKey), "HIDDEN_API_KEY")
    .replaceAll(apiKey, "HIDDEN_API_KEY");
}
    const broadJson = await fetchJson(broadUrl);
    const broadRows = Array.isArray(broadJson?.response?.data)
      ? broadJson.response.data
      : [];

    if (broadRows.length === 0) {
      return res.status(200).json({
        query,
        country,
        intent,
        message: "No EIA international data were found for that country.",
        selectedSeries: null,
        variables: []
      });
    }

    const candidates = buildCandidateVariables(broadRows, intent, query);

    if (candidates.length === 0) {
      return res.status(200).json({
        query,
        country,
        intent,
        message: "EIA returned rows, but no usable numeric values were found.",
        selectedSeries: null,
        variables: []
      });
    }

    const selected = candidates[0];

    const detailUrl = buildEiaDataUrl(apiKey, {
      countryCode: country.code,
      productId: selected.productId,
      activityId: selected.activityId,
      unit: selected.unitFacet,
      length: 5000
    });

    const detailJson = await fetchJson(detailUrl);
    const detailRows = Array.isArray(detailJson?.response?.data)
      ? detailJson.response.data
      : [];

    const cleanDetailRows = cleanDataRows(detailRows);
    const fullCoverage = getCoverage(cleanDetailRows);

    const points = cleanDetailRows
      .slice(0, 10)
      .reverse()
      .map(row => ({
        period: row.period,
        value: row.value
      }));

    return res.status(200).json({
      query,
      country,
      intent,
      source: "U.S. Energy Information Administration API, International Energy Statistics",
      selectedSeries: {
        title: selected.label,
        product: selected.productName,
        activity: selected.activityName,
        country: country.name,
        countryCode: country.code,
        unit: selected.unit,
        frequency: "Annual",
        dataCoverage: fullCoverage,
        observationsAvailable: cleanDetailRows.length,
        latestPeriod: selected.latestPeriod,
        latestValue: selected.latestValue,
        points
      },
      variables: candidates.slice(0, 30).map(variable => ({
        label: variable.label,
        product: variable.productName,
        activity: variable.activityName,
        unit: variable.unit,
        frequency: "Annual",
        dataCoverage: variable.dataCoverage,
        latestPeriod: variable.latestPeriod,
        latestValue: variable.latestValue,
        observationsFound: variable.observationsFound,
        matchScore: variable.score
      })),
      note: "The graph uses the best-matching variable and the latest 10 available annual observations."
    });
  } catch (error) {
    return res.status(500).json({
      error: "Server error while contacting or processing the EIA API.",
      details: error.message
    });
  }
}

async function getEiaCountries(apiKey) {
  const url =
    "https://api.eia.gov/v2/international/facet/countryRegionId/?api_key=" +
    encodeURIComponent(apiKey);

  try {
    const json = await fetchJson(url);
    const facets = Array.isArray(json?.response?.facets)
      ? json.response.facets
      : [];

    const countries = facets
      .filter(item => item && item.id && item.name)
      .map(item => ({
        code: String(item.id).trim(),
        name: String(item.name).trim(),
        alias: item.alias ? String(item.alias).trim() : ""
      }));

    if (countries.length > 0) return countries;
  } catch {
    // Fall back to common countries below.
  }

  return [
    { code: "USA", name: "United States", alias: "USA" },
    { code: "JPN", name: "Japan", alias: "Japan" },
    { code: "BRA", name: "Brazil", alias: "Brazil" },
    { code: "JOR", name: "Jordan", alias: "Jordan" },
    { code: "MEX", name: "Mexico", alias: "Mexico" },
    { code: "CAN", name: "Canada", alias: "Canada" },
    { code: "CHN", name: "China", alias: "China" },
    { code: "IND", name: "India", alias: "India" },
    { code: "DEU", name: "Germany", alias: "Germany" },
    { code: "FRA", name: "France", alias: "France" },
    { code: "GBR", name: "United Kingdom", alias: "UK" },
    { code: "KOR", name: "South Korea", alias: "South Korea" },
    { code: "SAU", name: "Saudi Arabia", alias: "Saudi Arabia" },
    { code: "ARE", name: "United Arab Emirates", alias: "UAE" },
    { code: "EGY", name: "Egypt", alias: "Egypt" },
    { code: "TUR", name: "Turkey", alias: "Turkey" },
    { code: "AUS", name: "Australia", alias: "Australia" }
  ];
}

function buildEiaDataUrl(apiKey, options) {
  const params = new URLSearchParams();

  params.set("api_key", apiKey);
  params.set("frequency", "annual");
  params.append("data[]", "value");
  params.append("facets[countryRegionId][]", options.countryCode);

  if (options.productId) {
    params.append("facets[productId][]", String(options.productId));
  }

  if (options.activityId) {
    params.append("facets[activityId][]", String(options.activityId));
  }

  if (options.unit) {
    params.append("facets[unit][]", String(options.unit));
  }

  params.set("sort[0][column]", "period");
  params.set("sort[0][direction]", "desc");
  params.set("offset", "0");
  params.set("length", String(options.length || 5000));

  return "https://api.eia.gov/v2/international/data/?" + params.toString();
}

function findCountryInQuery(query, countries) {
  const q = normalizeText(query);

  const aliasMap = new Map([
    ["us", "USA"],
    ["usa", "USA"],
    ["u s", "USA"],
    ["u s a", "USA"],
    ["u.s.", "USA"],
    ["united states", "USA"],
    ["america", "USA"],
    ["uk", "GBR"],
    ["u k", "GBR"],
    ["great britain", "GBR"],
    ["united kingdom", "GBR"],
    ["uae", "ARE"],
    ["u a e", "ARE"],
    ["south korea", "KOR"],
    ["north korea", "PRK"]
  ]);

  for (const [alias, code] of aliasMap.entries()) {
    if (hasPhrase(q, alias)) {
      const found = countries.find(country => country.code === code);
      if (found) return found;
      return { code, name: alias.toUpperCase(), alias };
    }
  }

  const codeMatch = q.match(/\b[a-z]{3}\b/);
  if (codeMatch) {
    const found = countries.find(country => normalizeText(country.code) === codeMatch[0]);
    if (found) return found;
  }

  const matches = countries
    .map(country => ({
      country,
      nameNorm: normalizeText(country.name),
      aliasNorm: normalizeText(country.alias)
    }))
    .filter(item => {
      return (
        item.nameNorm && hasPhrase(q, item.nameNorm)
      ) || (
        item.aliasNorm && hasPhrase(q, item.aliasNorm)
      );
    })
    .sort((a, b) => b.nameNorm.length - a.nameNorm.length);

  if (matches.length > 0) return matches[0].country;

  return null;
}

function detectIntent(query) {
  const q = normalizeText(query);

  const activityRules = [
    { value: "consumption", terms: ["consumption", "consume", "use", "usage", "demand"] },
    { value: "production", terms: ["production", "produce", "supply"] },
    { value: "imports", terms: ["imports", "import"] },
    { value: "exports", terms: ["exports", "export"] },
    { value: "generation", terms: ["generation", "generated"] },
    { value: "reserves", terms: ["reserves", "reserve"] },
    { value: "price", terms: ["price", "prices"] }
  ];

  const productRules = [
    { value: "natural gas", terms: ["natural gas", "gas"] },
    { value: "petroleum", terms: ["petroleum", "oil", "crude", "gasoline", "diesel"] },
    { value: "electricity", terms: ["electricity", "power"] },
    { value: "coal", terms: ["coal"] },
    { value: "solar", terms: ["solar"] },
    { value: "wind", terms: ["wind"] },
    { value: "renewable", terms: ["renewable", "renewables"] },
    { value: "hydro", terms: ["hydro", "hydroelectric"] },
    { value: "nuclear", terms: ["nuclear"] },
    { value: "total energy", terms: ["total energy", "energy"] }
  ];

  return {
    activity: firstRuleMatch(q, activityRules),
    product: firstRuleMatch(q, productRules)
  };
}

function firstRuleMatch(text, rules) {
  for (const rule of rules) {
    if (rule.terms.some(term => hasPhrase(text, normalizeText(term)))) {
      return rule.value;
    }
  }

  return null;
}

function buildCandidateVariables(rows, intent, query) {
  const groups = new Map();

  for (const row of rows) {
    const value = toNumber(row.value);
    if (!row.period || !Number.isFinite(value)) continue;

    const productId = String(row.productId || "").trim();
    const productName = String(row.productName || productId).trim();
    const activityId = String(row.activityId || "").trim();
    const activityName = String(row.activityName || activityId).trim();
    const unitFacet = String(row.unit || "").trim();
    const unit = String(row.unitName || row.unit || row["value-units"] || "").trim();

    if (!productId || !activityId || !unit) continue;

    const key = productId + "|" + activityId + "|" + (unitFacet || unit);

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
      period: String(row.period),
      value
    });
  }

  const candidates = [];

  for (const group of groups.values()) {
    const cleanRows = uniquePeriods(group.rows)
      .sort((a, b) => comparePeriodsDesc(a.period, b.period));

    if (cleanRows.length === 0) continue;

    const score =
      scoreVariable(group, intent, query) +
      Math.min(cleanRows.length, 20) * 0.25;

    candidates.push({
      ...group,
      label: group.productName + " — " + group.activityName,
      latestPeriod: cleanRows[0].period,
      latestValue: cleanRows[0].value,
      dataCoverage: getCoverage(cleanRows),
      observationsFound: cleanRows.length,
      score
    });
  }

  return candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.observationsFound !== a.observationsFound) {
      return b.observationsFound - a.observationsFound;
    }
    return String(a.label).localeCompare(String(b.label));
  });
}

function cleanDataRows(rows) {
  return uniquePeriods(
    rows
      .map(row => ({
        period: String(row.period || ""),
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

function getCoverage(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return "Not available";

  const periods = rows
    .map(row => String(row.period || "").trim())
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));

  if (periods.length === 0) return "Not available";

  return periods[0] + "–" + periods[periods.length - 1];
}

function scoreVariable(group, intent, query) {
  const q = normalizeText(query);
  const product = normalizeText(group.productName);
  const activity = normalizeText(group.activityName);
  const text = product + " " + activity + " " + normalizeText(group.unit);

  let score = 0;

  if (intent.activity && activity.includes(intent.activity)) score += 70;
  if (intent.product && product.includes(intent.product)) score += 70;

  if (intent.product === "total energy" && product.includes("total energy")) score += 50;
  if (intent.product === "petroleum" && (product.includes("petroleum") || product.includes("oil"))) score += 30;
  if (intent.product === "renewable" && product.includes("renewable")) score += 30;

  if (q.includes("energy consumption") && product.includes("total energy") && activity.includes("consumption")) score += 80;
  if (q.includes("electricity generation") && product.includes("electricity") && activity.includes("generation")) score += 80;
  if (q.includes("natural gas production") && product.includes("natural gas") && activity.includes("production")) score += 80;
  if (q.includes("oil consumption") && product.includes("petroleum") && activity.includes("consumption")) score += 80;

  for (const word of q.split(" ")) {
    if (word.length > 3 && text.includes(word)) score += 3;
  }

  if (activity.includes("consumption")) score += 5;
  if (product.includes("total energy")) score += 5;

  return score;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();

    let json;

    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("Expected JSON but received: " + text.slice(0, 200));
    }

    if (!response.ok) {
      const message =
        json?.error ||
        json?.message ||
        json?.response?.error ||
        "HTTP " + response.status;

      throw new Error("EIA request failed: " + message);
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function comparePeriodsDesc(a, b) {
  return String(b).localeCompare(String(a), undefined, { numeric: true });
}

function hasPhrase(text, phrase) {
  const cleanText = " " + normalizeText(text) + " ";
  const cleanPhrase = " " + normalizeText(phrase) + " ";
  return cleanText.includes(cleanPhrase);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toNumber(value) {
  if (value === null || value === undefined) return NaN;
  return Number(String(value).replace(/,/g, ""));
}
