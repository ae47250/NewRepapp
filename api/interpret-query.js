const PRODUCT_RULES = [
  { value: "natural gas", terms: ["natural gas", "nat gas", "gas"] },
  { value: "petroleum", terms: ["petroleum", "oil", "crude", "crude oil", "gasoline", "diesel", "liquid fuels", "petroleum and other liquids"] },
  { value: "electricity", terms: ["electricity", "electric power", "power"] },
  { value: "coal", terms: ["coal"] },
  { value: "nuclear", terms: ["nuclear"] },
  { value: "renewable", terms: ["renewable", "renewables", "renewable energy"] },
  { value: "hydro", terms: ["hydro", "hydroelectric", "hydropower"] },
  { value: "solar", terms: ["solar"] },
  { value: "wind", terms: ["wind"] },
  { value: "biofuels", terms: ["biofuel", "biofuels", "biomass"] },
  { value: "total energy", terms: ["total energy", "primary energy", "energy"] }
];

const ACTIVITY_RULES = [
  { value: "consumption", terms: ["consumption", "consume", "consumed", "use", "usage", "demand"] },
  { value: "production", terms: ["production", "produce", "produced", "supply", "output"] },
  { value: "generation", terms: ["generation", "generated", "electricity generation", "power generation"] },
  { value: "imports", terms: ["imports", "import", "imported"] },
  { value: "exports", terms: ["exports", "export", "exported"] },
  { value: "reserves", terms: ["reserves", "reserve"] },
  { value: "capacity", terms: ["capacity"] },
  { value: "prices", terms: ["price", "prices", "cost"] }
];

const FREQUENCY_RULES = [
  { value: "monthly", terms: ["monthly", "month", "months"] },
  { value: "quarterly", terms: ["quarterly", "quarter", "quarters"] },
  { value: "annual", terms: ["annual", "yearly", "year", "years"] }
];

const COUNTRY_ALIASES = new Map([
  ["us", "USA"],
  ["usa", "USA"],
  ["u s", "USA"],
  ["u s a", "USA"],
  ["united states", "USA"],
  ["united states of america", "USA"],
  ["america", "USA"],
  ["uk", "GBR"],
  ["u k", "GBR"],
  ["britain", "GBR"],
  ["great britain", "GBR"],
  ["united kingdom", "GBR"],
  ["uae", "ARE"],
  ["u a e", "ARE"],
  ["emirates", "ARE"],
  ["south korea", "KOR"],
  ["korea south", "KOR"],
  ["north korea", "PRK"],
  ["korea north", "PRK"],
  ["russia", "RUS"],
  ["iran", "IRN"],
  ["venezuela", "VEN"],
  ["bolivia", "BOL"],
  ["tanzania", "TZA"],
  ["vietnam", "VNM"],
  ["laos", "LAO"],
  ["syria", "SYR"],
  ["moldova", "MDA"],
  ["brunei", "BRN"]
]);

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "can", "chart", "compare", "comparison",
  "countries", "country", "data", "download", "eia", "energy", "for", "from", "graph", "i",
  "in", "into", "last", "latest", "line", "list", "me", "of", "on", "or", "over", "please",
  "plot", "recent", "search", "series", "show", "table", "than", "the", "to", "trend", "versus",
  "vs", "want", "with", "years", "year"
]);

export default async function handler(req, res) {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      error: "Missing query.",
      userMessage: "Enter a search phrase such as Brazil energy consumption."
    });
  }

  return res.status(200).json({
    intent: interpretQuery(query)
  });
}

export function interpretQuery(query, countries = []) {
  const normalizedQuery = normalizeText(query);
  const detectedCountries = detectCountries(normalizedQuery, countries);
  const product = firstRuleMatch(normalizedQuery, PRODUCT_RULES);
  const activity = firstRuleMatch(normalizedQuery, ACTIVITY_RULES);
  const frequency = firstRuleMatch(normalizedQuery, FREQUENCY_RULES) || "annual";
  const comparison = detectComparison(normalizedQuery, detectedCountries.length);
  const cleanedKeywords = buildCleanedKeywords(normalizedQuery, detectedCountries);

  return {
    originalQuery: String(query || "").trim(),
    normalizedQuery,
    mode: comparison ? "comparison" : "single",
    comparison,
    countries: detectedCountries,
    countryCodes: detectedCountries.map(country => country.code),
    primaryCountry: detectedCountries[0] || null,
    product,
    activity,
    frequency,
    cleanedKeywords
  };
}

export function detectCountries(normalizedQuery, countries = []) {
  const found = new Map();
  const countryList = Array.isArray(countries) ? countries : [];

  for (const [alias, code] of COUNTRY_ALIASES.entries()) {
    if (!hasPhrase(normalizedQuery, alias)) continue;
    const country = findCountryByCode(countryList, code) || { code, name: alias.toUpperCase(), alias };
    found.set(country.code, country);
  }

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  for (const token of tokens) {
    if (token.length !== 3) continue;
    const country = findCountryByCode(countryList, token.toUpperCase());
    if (country) found.set(country.code, country);
  }

  const countryMatches = countryList
    .map(country => ({
      country,
      nameNorm: normalizeText(country.name),
      aliasNorm: normalizeText(country.alias || "")
    }))
    .filter(item => item.nameNorm && hasPhrase(normalizedQuery, item.nameNorm))
    .sort((a, b) => b.nameNorm.length - a.nameNorm.length);

  for (const match of countryMatches) {
    found.set(match.country.code, match.country);
  }

  for (const item of countryList) {
    const aliasNorm = normalizeText(item.alias || "");
    if (aliasNorm && hasPhrase(normalizedQuery, aliasNorm)) {
      found.set(item.code, item);
    }
  }

  return Array.from(found.values());
}

export function findCountryByCode(countries, code) {
  const target = normalizeText(code).toUpperCase();
  return (countries || []).find(country => String(country.code || "").toUpperCase() === target) || null;
}

export function firstRuleMatch(text, rules) {
  for (const rule of rules) {
    if (rule.terms.some(term => hasPhrase(text, normalizeText(term)))) {
      return rule.value;
    }
  }
  return null;
}

export function detectComparison(normalizedQuery, numberOfCountries = 0) {
  if (numberOfCountries > 1) return true;
  return /\b(compare|comparison|versus|vs|against)\b/.test(normalizedQuery);
}

export function buildCleanedKeywords(normalizedQuery, countries = []) {
  const countryWords = new Set();

  for (const country of countries) {
    for (const word of normalizeText(country.name).split(" ")) {
      if (word) countryWords.add(word);
    }
    for (const word of normalizeText(country.code).split(" ")) {
      if (word) countryWords.add(word);
    }
  }

  for (const rule of [...PRODUCT_RULES, ...ACTIVITY_RULES, ...FREQUENCY_RULES]) {
    for (const term of rule.terms) {
      for (const word of normalizeText(term).split(" ")) {
        if (word) countryWords.add(word);
      }
    }
  }

  return normalizedQuery
    .split(" ")
    .filter(word => word.length > 2)
    .filter(word => !STOP_WORDS.has(word))
    .filter(word => !countryWords.has(word))
    .join(" ");
}

export function hasPhrase(text, phrase) {
  const cleanText = ` ${normalizeText(text)} `;
  const cleanPhrase = ` ${normalizeText(phrase)} `;
  return cleanText.includes(cleanPhrase);
}

export function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}          },
          {
            role: "user",
            content:
              "User query: " + query + "\n\n" +
              "Return JSON with these exact fields:\n" +
              "{\n" +
              "  \"originalQuery\": string,\n" +
              "  \"searchQuery\": string,\n" +
              "  \"country\": string,\n" +
              "  \"countryIso\": string,\n" +
              "  \"topic\": string,\n" +
              "  \"product\": string,\n" +
              "  \"activity\": string,\n" +
              "  \"frequency\": string,\n" +
              "  \"observations\": number|null,\n" +
              "  \"needsClarification\": boolean,\n" +
              "  \"clarificationQuestion\": string\n" +
              "}\n\n" +
              "Rules:\n" +
              "- Keep searchQuery short, like 'United States energy consumption'.\n" +
              "- Use country name, not slang, in searchQuery.\n" +
              "- 'usa', 'us', and 'america' mean United States.\n" +
              "- 'power' usually means electricity.\n" +
              "- 'gas' usually means natural gas unless gasoline is clearly implied.\n" +
              "- 'energy' by itself usually means primary energy.\n" +
              "- Use annual frequency unless the user clearly asks otherwise.\n" +
              "- Use 10 observations for recent/latest/last decade; otherwise null."
          }
        ],
        text: {
          format: {
            type: "json_object"
          }
        },
        store: false
      })
    });

    const rawText = await response.text();
    let apiJson;

    try {
      apiJson = JSON.parse(rawText);
    } catch {
      throw new Error("OpenAI returned non-JSON response: " + rawText.slice(0, 300));
    }

    if (!response.ok) {
      const message =
        apiJson?.error?.message ||
        apiJson?.error ||
        "OpenAI API request failed.";

      throw new Error(message);
    }

    const outputText = extractOutputText(apiJson);

    if (!outputText) {
      throw new Error("OpenAI response did not contain output text.");
    }

    const interpreted = JSON.parse(outputText);
    const cleaned = cleanInterpretation(query, interpreted);

    return res.status(200).json(cleaned);
  } catch (error) {
    return res.status(200).json({
      originalQuery: query,
      searchQuery: query,
      aiUsed: false,
      warning: "AI interpretation failed. Used original query instead.",
      details: error.message
    });
  }
}

function getQuery(req) {
  if (req.method === "POST") {
    return String(req.body?.q || req.body?.query || "").trim();
  }

  return String(req.query.q || req.query.query || "").trim();
}

function extractOutputText(apiJson) {
  if (typeof apiJson.output_text === "string" && apiJson.output_text.trim()) {
    return apiJson.output_text.trim();
  }

  if (!Array.isArray(apiJson.output)) {
    return "";
  }

  const parts = [];

  for (const item of apiJson.output) {
    if (!Array.isArray(item.content)) continue;

    for (const contentItem of item.content) {
      if (typeof contentItem.text === "string") {
        parts.push(contentItem.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function cleanInterpretation(originalQuery, interpreted) {
  const country = cleanString(interpreted.country);
  const topic = cleanString(interpreted.topic);
  const product = cleanString(interpreted.product);
  const activity = cleanString(interpreted.activity);

  let searchQuery = cleanString(interpreted.searchQuery);

  if (!searchQuery) {
    searchQuery = [country, topic || product, activity]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!searchQuery) {
    searchQuery = originalQuery;
  }

  return {
    originalQuery,
    searchQuery,
    country,
    countryIso: cleanString(interpreted.countryIso).toUpperCase(),
    topic,
    product,
    activity,
    frequency: cleanString(interpreted.frequency) || "Annual",
    observations: normalizeObservations(interpreted.observations),
    needsClarification: Boolean(interpreted.needsClarification),
    clarificationQuestion: cleanString(interpreted.clarificationQuestion),
    aiUsed: true
  };
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function normalizeObservations(value) {
  if (value === null || value === undefined || value === "") return null;

  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) return null;

  return Math.round(number);
}
