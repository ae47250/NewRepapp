import { interpretQuery, findCountryByCode, hasPhrase, normalizeText } from "./interpret-query.js";

const EIA_BASE_URL = "https://api.eia.gov/v2/international";
const DEFAULT_FREQUENCY = "annual";
const MAX_BROAD_ROWS = 5000;
const MAX_SERIES_ROWS = 5000;
const VARIABLE_LIMIT = 12;
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
      userMessage: "Use the search box on the webpage or send a GET request."
    });
  }

  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "Missing EIA_API_KEY environment variable.",
      userMessage: "The EIA API key is missing in Vercel. Add EIA_API_KEY under Project Settings → Environment Variables, then redeploy."
    });
  }

  const query = String(req.query.q || "").trim();
  if (!query) {
    return res.status(400).json({
      error: "Missing search query.",
      userMessage: "Enter a search such as Brazil energy consumption."
    });
  }

  try {
    const countries = await getEiaCountries(apiKey);
    const intent = interpretQuery(query, countries);
    const country = resolveCountry(req.query.country, intent, countries);
    const frequency = sanitizeFrequency(req.query.frequency || intent.frequency || DEFAULT_FREQUENCY);
    const productId = cleanFacet(req.query.productId);
    const activityId = cleanFacet(req.query.activityId);
    const unit = cleanFacet(req.query.unit);

    if (!country) {
      return res.status(200).json({
        query,
        intent,
        needsCountry: true,
        selectedSeries: null,
        variables: [],
        userMessage: "Please include one country name. Examples: Brazil energy consumption, Jordan electricity generation, Mexico natural gas production."
      });
    }

    if (productId && activityId && unit) {
      const selectedSeries = await fetchExactSeries({ apiKey, country, productId, activityId, unit, frequency });
      return res.status(200).json({
        query,
        country,
        intent,
        source: "U.S. Energy Information Administration API, International Energy Statistics",
        selectedSeries,
        variables: [],
        note: "Coverage is computed from actual observations returned for the selected EIA series."
      });
    }

    const payload = await buildSingleCountrySearch({ apiKey, country, query, intent, frequency });
    return res.status(200).json(payload);
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
      country,
      intent,
      selectedSeries: null,
      variables: [],
      userMessage: `EIA returned no ${frequency} international rows for ${country.name}.`
    };
  }

  const rawCandidates = buildCandidateVariables(broadRows, intent, query).slice(0, VARIABLE_LIMIT);

  if (rawCandidates.length === 0) {
    return {
      query,
      country,
      intent,
      selectedSeries: null,
      variables: [],
      userMessage: "EIA returned rows, but no usable numeric series were found. Try a broader search such as Brazil energy consumption."
    };
  }

  const enrichedCandidates = await enrichCandidates({ apiKey, country, candidates: rawCandidates, frequency });
  const selectedSeries = enrichedCandidates[0]?.series || null;

  return {
    query,
    country,
    intent,
    source: "U.S. Energy Information Administration API, International Energy Statistics",
    selectedSeries,
    variables: enrichedCandidates.map(item => item.variable),
    note: "Coverage is computed from actual observations for each displayed series, not from the partial search list."
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

async function enrichCandidates({ apiKey, country, candidates, frequency }) {
  const settled = await Promise.allSettled(
    candidates.map(candidate => fetchExactSeries({
      apiKey,
      country,
      productId: candidate.productId,
      activityId: candidate.activityId,
      unit: candidate.unitFacet,
      frequency
    }))
  );

  return settled
    .map((result, index) => {
      if (result.status !== "fulfilled") return null;
      const series = result.value;
      if (!series || !Array.isArray(series.points) || series.points.length === 0) return null;
      return {
        series,
        variable: {
          label: series.title,
          country: series.country,
          countryCode: series.countryCode,
          productId: series.productId,
          activityId: series.activityId,
          unitFacet: series.unitFacet,
          product: series.product,
          activity: series.activity,
          coverage: formatCoverage(series.coverage),
          frequency: series.frequency,
          unit: series.unit,
          latestPeriod: series.latestPeriod,
          latestValue: series.latestValue,
          observationsFound: series.coverage?.count || 0,
          matchScore: candidates[index]?.score || 0
        }
      };
    })
    .filter(Boolean);
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
  const points = cleanDataRows(rows);

  if (points.length === 0) {
    throw new Error("EIA returned metadata but no numeric observations for that series.");
  }

  const sample = rows[0] || {};
  const coverage = computeCoverage(points);
  const latest = points[points.length - 1];
  const productName = getField(sample, "productName") || `Product ${productId}`;
  const activityName = getField(sample, "activityName") || `Activity ${activityId}`;
  const unitName = getUnitName(sample) || unit;

  return {
    title: `${productName} — ${activityName}`,
    product: productName,
    activity: activityName,
    country: country.name,
    countryCode: country.code,
    productId: String(productId),
    activityId: String(activityId),
    unitFacet: String(unit),
    unit: unitName,
    frequency,
    coverage,
    latestPeriod: latest.period,
    latestValue: latest.value,
    points
  };
}

function buildCandidateVariables(rows, intent, query) {
  const groups = new Map();

  for (const row of rows) {
    const value = toNumber(getField(row, "value"));
    if (!Number.isFinite(value)) continue;

    const productId = getField(row, "productId");
    const activityId = getField(row, "activityId");
    const unitFacet = getField(row, "unit");
    if (!productId || !activityId || !unitFacet) continue;

    const key = `${productId}|${activityId}|${unitFacet}`;
    if (!groups.has(key)) {
      groups.set(key, {
        productId: String(productId),
        activityId: String(activityId),
        unitFacet: String(unitFacet),
        productName: getField(row, "productName") || "",
        activityName: getField(row, "activityName") || "",
        unit: getUnitName(row) || String(unitFacet),
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  }

  const candidates = [];
  for (const group of groups.values()) {
    const cleanRows = cleanDataRows(group.rows);
    if (cleanRows.length === 0) continue;

    const score = scoreVariable(group, intent, query) + Math.min(cleanRows.length, 20) * 0.1;
    const latest = cleanRows[cleanRows.length - 1];

    candidates.push({
      ...group,
      label: `${group.productName} — ${group.activityName}`,
      latestPeriod: latest.period,
      latestValue: latest.value,
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
  const text = `${product} ${activity} ${normalizeText(group.unit)}`;
  let score = 0;

  if (intent.activity && activity.includes(intent.activity)) score += 50;
  if (intent.product && productMatches(intent.product, product)) score += 50;

  if (q.includes("energy consumption") && productMatches("total energy", product) && activity.includes("consumption")) score += 60;
  if (q.includes("electricity generation") && product.includes("electricity") && activity.includes("generation")) score += 60;
  if (q.includes("natural gas production") && product.includes("natural gas") && activity.includes("production")) score += 60;
  if (q.includes("oil consumption") && productMatches("petroleum", product) && activity.includes("consumption")) score += 60;

  for (const word of q.split(" ")) {
    if (word.length > 3 && hasPhrase(text, word)) score += 2;
  }

  return score;
}

function productMatches(intentProduct, productText) {
  if (!intentProduct) return false;
  if (productText.includes(intentProduct)) return true;
  if (intentProduct === "total energy") return productText.includes("primary energy") || productText.includes("total energy");
  if (intentProduct === "petroleum") return productText.includes("petroleum") || productText.includes("oil") || productText.includes("liquid fuels");
  if (intentProduct === "renewable") return productText.includes("renewable") || productText.includes("renewables");
  if (intentProduct === "hydro") return productText.includes("hydro") || productText.includes("hydroelectric");
  return false;
}

async function getEiaCountries(apiKey) {
  const url = `${EIA_BASE_URL}/facet/countryRegionId/?api_key=${encodeURIComponent(apiKey)}`;

  try {
    const json = await fetchJsonCached(url, COUNTRY_CACHE_TTL_MS, apiKey);
    const rows = Array.isArray(json?.response?.facets) ? json.response.facets
      : Array.isArray(json?.response?.data) ? json.response.data
      : Array.isArray(json?.response) ? json.response
      : [];

    const countries = rows
      .map(row => ({
        code: String(row.id || row.value || row.countryRegionId || row.code || "").trim(),
        name: String(row.name || row.description || row.countryRegionName || row.label || "").trim()
      }))
      .filter(country => country.code && country.name);

    if (countries.length > 0) return countries;
  } catch {
    // Fall through to the static list in interpret-query.js through its fallback.
  }

  return [];
}

function resolveCountry(countryParam, intent, countries) {
  const requested = String(countryParam || "").trim();
  if (requested) {
    const byCode = findCountryByCode(countries, requested);
    if (byCode) return byCode;
    const normalized = normalizeText(requested);
    const byName = countries.find(country => hasPhrase(normalizeText(country.name), normalized));
    if (byName) return byName;
  }

  return intent.country || null;
}

function buildEiaDataUrl(apiKey, { countryCode, productId, activityId, unit, frequency = DEFAULT_FREQUENCY, length = 5000 }) {
  const url = new URL(`${EIA_BASE_URL}/data/`);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("frequency", sanitizeFrequency(frequency));
  url.searchParams.set("data[0]", "value");
  url.searchParams.append("facets[countryRegionId][]", countryCode);

  if (productId) url.searchParams.append("facets[productId][]", productId);
  if (activityId) url.searchParams.append("facets[activityId][]", activityId);
  if (unit) url.searchParams.append("facets[unit][]", unit);

  url.searchParams.set("sort[0][column]", "period");
  url.searchParams.set("sort[0][direction]", "desc");
  url.searchParams.set("offset", "0");
  url.searchParams.set("length", String(length));
  return url.toString();
}

function cleanDataRows(rows) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    const period = String(getField(row, "period") || "").trim();
    const value = toNumber(getField(row, "value"));
    if (!period || !Number.isFinite(value) || seen.has(period)) continue;
    seen.add(period);
    output.push({ period, value });
  }

  return output.sort((a, b) => comparePeriods(a.period, b.period));
}

function computeCoverage(points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  return {
    start: points[0].period,
    end: points[points.length - 1].period,
    count: points.length
  };
}

function formatCoverage(coverage) {
  if (!coverage) return "";
  if (coverage.start === coverage.end) return `${coverage.start} (${coverage.count} obs.)`;
  return `${coverage.start}–${coverage.end} (${coverage.count} obs.)`;
}

function getField(row, field) {
  return row?.[field] ?? row?.[field.toLowerCase()] ?? row?.[field.toUpperCase()];
}

function getUnitName(row) {
  return row?.["value-units"] || row?.unitName || row?.unitDescription || row?.unit || "";
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const cleaned = value.replace(/,/g, "").trim();
  if (cleaned === "" || cleaned.toLowerCase() === "na") return Number.NaN;
  return Number(cleaned);
}

function comparePeriods(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

function sanitizeFrequency(value) {
  const normalized = normalizeText(value || DEFAULT_FREQUENCY);
  if (["monthly", "quarterly", "annual"].includes(normalized)) return normalized;
  return DEFAULT_FREQUENCY;
}

function cleanFacet(value) {
  const text = String(value || "").trim();
  if (!text || text === "undefined" || text === "null") return "";
  return text;
}

async function fetchJsonCached(url, ttlMs, apiKey) {
  const now = Date.now();
  const cached = cache.get(url);

  if (cached && now - cached.createdAt < ttlMs) return cached.value;

  const value = await fetchJson(url, apiKey);
  cache.set(url, { createdAt: now, value });
  pruneCache();
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

    return json;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("The EIA request timed out.");
    throw new Error(hideApiKey(error.message, apiKey));
  } finally {
    clearTimeout(timeout);
  }
}

function pruneCache() {
  if (cache.size <= MAX_CACHE_ITEMS) return;
  const keys = Array.from(cache.keys());
  for (const key of keys.slice(0, cache.size - MAX_CACHE_ITEMS)) cache.delete(key);
}

function friendlyErrorMessage(error) {
  const message = String(error?.message || "");

  if (message.includes("timed out")) return "The EIA API request timed out. Try the same search again.";
  if (message.includes("non-JSON")) return "EIA returned an unexpected response. Check the API route and Vercel function logs.";
  if (message.includes("EIA request failed")) return "EIA rejected the request. Check the selected country/series or try a broader search.";
  if (message.includes("fetch failed") || message.includes("network")) return "The backend could not reach EIA. Try again later.";
  if (message.includes("no numeric observations")) return "EIA found the series metadata but returned no numeric observations for that exact series.";

  return "Something went wrong while contacting EIA. Check the Vercel function logs for details.";
}

function hideApiKey(text, apiKey) {
  return String(text || "").replaceAll(apiKey || "", "[hidden-api-key]");
}

function setJsonHeaders(res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
}
