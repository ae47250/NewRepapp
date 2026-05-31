export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  const apiKey = process.env.EIA_API_KEY;
  const query = String(req.query.q || "").trim();

  if (!apiKey) {
    return res.status(500).json({
      error: "Missing EIA_API_KEY environment variable in Vercel."
    });
  }

  if (!query) {
    return res.status(400).json({
      error: "Missing search query. Example: Brazil energy consumption."
    });
  }

  try {
    const countries = await getEiaCountries(apiKey);
    const country = findCountryInQuery(query, countries);

    if (!country) {
      return res.status(200).json({
        query,
        needsCountry: true,
        message: "Please include a country name. Examples: Brazil energy consumption, Mexico natural gas production, Japan electricity generation."
      });
    }

    const intent = detectIntent(query);

    const broadUrl = buildEiaDataUrl(apiKey, {
      countryCode: country.code,
      length: 5000
    });

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
