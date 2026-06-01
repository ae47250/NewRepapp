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
  ["us", "USA"], ["usa", "USA"], ["u s", "USA"], ["u s a", "USA"],
  ["united states", "USA"], ["united states of america", "USA"], ["america", "USA"],
  ["uk", "GBR"], ["u k", "GBR"], ["britain", "GBR"], ["great britain", "GBR"], ["united kingdom", "GBR"],
  ["uae", "ARE"], ["u a e", "ARE"], ["emirates", "ARE"],
  ["south korea", "KOR"], ["korea south", "KOR"], ["north korea", "PRK"], ["korea north", "PRK"],
  ["russia", "RUS"], ["iran", "IRN"], ["venezuela", "VEN"], ["bolivia", "BOL"], ["tanzania", "TZA"],
  ["vietnam", "VNM"], ["laos", "LAO"], ["syria", "SYR"], ["moldova", "MDA"], ["brunei", "BRN"],
  ["czech republic", "CZE"], ["czechia", "CZE"], ["ivory coast", "CIV"], ["cote d ivoire", "CIV"]
]);

const FALLBACK_COUNTRIES = [
  ["Afghanistan", "AFG"], ["Albania", "ALB"], ["Algeria", "DZA"], ["Argentina", "ARG"], ["Armenia", "ARM"], ["Australia", "AUS"], ["Austria", "AUT"], ["Azerbaijan", "AZE"],
  ["Bahrain", "BHR"], ["Bangladesh", "BGD"], ["Belarus", "BLR"], ["Belgium", "BEL"], ["Bolivia", "BOL"], ["Brazil", "BRA"], ["Bulgaria", "BGR"],
  ["Canada", "CAN"], ["Chile", "CHL"], ["China", "CHN"], ["Colombia", "COL"], ["Costa Rica", "CRI"], ["Croatia", "HRV"], ["Cuba", "CUB"], ["Cyprus", "CYP"], ["Czechia", "CZE"],
  ["Denmark", "DNK"], ["Dominican Republic", "DOM"], ["Ecuador", "ECU"], ["Egypt", "EGY"], ["Estonia", "EST"], ["Ethiopia", "ETH"],
  ["Finland", "FIN"], ["France", "FRA"], ["Georgia", "GEO"], ["Germany", "DEU"], ["Ghana", "GHA"], ["Greece", "GRC"], ["Guatemala", "GTM"],
  ["Honduras", "HND"], ["Hong Kong", "HKG"], ["Hungary", "HUN"], ["Iceland", "ISL"], ["India", "IND"], ["Indonesia", "IDN"], ["Iran", "IRN"], ["Iraq", "IRQ"], ["Ireland", "IRL"], ["Israel", "ISR"], ["Italy", "ITA"],
  ["Jamaica", "JAM"], ["Japan", "JPN"], ["Jordan", "JOR"], ["Kazakhstan", "KAZ"], ["Kenya", "KEN"], ["Kuwait", "KWT"],
  ["Latvia", "LVA"], ["Lebanon", "LBN"], ["Libya", "LBY"], ["Lithuania", "LTU"], ["Luxembourg", "LUX"],
  ["Malaysia", "MYS"], ["Mexico", "MEX"], ["Morocco", "MAR"], ["Netherlands", "NLD"], ["New Zealand", "NZL"], ["Nigeria", "NGA"], ["Norway", "NOR"],
  ["Oman", "OMN"], ["Pakistan", "PAK"], ["Panama", "PAN"], ["Peru", "PER"], ["Philippines", "PHL"], ["Poland", "POL"], ["Portugal", "PRT"],
  ["Qatar", "QAT"], ["Romania", "ROU"], ["Russia", "RUS"], ["Saudi Arabia", "SAU"], ["Serbia", "SRB"], ["Singapore", "SGP"], ["Slovakia", "SVK"], ["Slovenia", "SVN"], ["South Africa", "ZAF"], ["South Korea", "KOR"], ["Spain", "ESP"], ["Sri Lanka", "LKA"], ["Sweden", "SWE"], ["Switzerland", "CHE"], ["Syria", "SYR"],
  ["Taiwan", "TWN"], ["Thailand", "THA"], ["Tunisia", "TUN"], ["Turkey", "TUR"], ["Ukraine", "UKR"], ["United Arab Emirates", "ARE"], ["United Kingdom", "GBR"], ["United States", "USA"], ["Uruguay", "URY"], ["Venezuela", "VEN"], ["Vietnam", "VNM"], ["World", "WOR"]
].map(([name, code]) => ({ name, code }));

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "by", "can", "chart", "countries", "country", "data", "download", "eia", "energy", "for", "from", "graph", "i", "in", "into", "last", "latest", "line", "list", "me", "of", "on", "or", "over", "please", "plot", "recent", "search", "series", "show", "table", "the", "to", "trend", "want", "with", "years", "year"
]);

export default async function handler(req, res) {
  const query = String(req.query.q || "").trim();

  if (!query) {
    return res.status(400).json({
      error: "Missing query.",
      userMessage: "Enter a search phrase such as Brazil energy consumption."
    });
  }

  return res.status(200).json({ intent: interpretQuery(query) });
}

export function interpretQuery(query, countries = []) {
  const normalizedQuery = normalizeText(query);
  const countryList = mergeCountries(countries, FALLBACK_COUNTRIES);
  const detectedCountries = detectCountries(normalizedQuery, countryList);
  const product = firstRuleMatch(normalizedQuery, PRODUCT_RULES);
  const activity = firstRuleMatch(normalizedQuery, ACTIVITY_RULES);
  const frequency = firstRuleMatch(normalizedQuery, FREQUENCY_RULES) || "annual";

  return {
    originalQuery: String(query || "").trim(),
    normalizedQuery,
    mode: "single",
    country: detectedCountries[0] || null,
    countryCode: detectedCountries[0]?.code || null,
    extraCountriesIgnored: detectedCountries.slice(1),
    product,
    activity,
    frequency,
    cleanedKeywords: buildCleanedKeywords(normalizedQuery, detectedCountries)
  };
}

export function detectCountries(normalizedQuery, countries = []) {
  const found = new Map();
  const countryList = Array.isArray(countries) ? countries : [];

  for (const [alias, code] of COUNTRY_ALIASES.entries()) {
    if (!hasPhrase(normalizedQuery, alias)) continue;
    const country = findCountryByCode(countryList, code) || { code, name: alias.toUpperCase() };
    found.set(country.code, country);
  }

  const tokens = normalizedQuery.split(" ").filter(Boolean);
  for (const token of tokens) {
    if (token.length !== 3) continue;
    const country = findCountryByCode(countryList, token.toUpperCase());
    if (country) found.set(country.code, country);
  }

  const countryMatches = countryList
    .map(country => ({ country, nameNorm: normalizeText(country.name) }))
    .filter(item => item.nameNorm && hasPhrase(normalizedQuery, item.nameNorm))
    .sort((a, b) => b.nameNorm.length - a.nameNorm.length);

  for (const match of countryMatches) found.set(match.country.code, match.country);

  return Array.from(found.values());
}

export function findCountryByCode(countries, code) {
  const target = String(code || "").toUpperCase();
  return (countries || []).find(country => String(country.code || "").toUpperCase() === target) || null;
}

export function firstRuleMatch(text, rules) {
  for (const rule of rules) {
    if (rule.terms.some(term => hasPhrase(text, normalizeText(term)))) return rule.value;
  }
  return null;
}

export function buildCleanedKeywords(normalizedQuery, countries = []) {
  const ignoreWords = new Set();

  for (const country of countries) {
    for (const word of normalizeText(country.name).split(" ")) if (word) ignoreWords.add(word);
    if (country.code) ignoreWords.add(normalizeText(country.code));
  }

  for (const rule of [...PRODUCT_RULES, ...ACTIVITY_RULES, ...FREQUENCY_RULES]) {
    for (const term of rule.terms) {
      for (const word of normalizeText(term).split(" ")) if (word) ignoreWords.add(word);
    }
  }

  return normalizedQuery
    .split(" ")
    .filter(word => word.length > 2)
    .filter(word => !STOP_WORDS.has(word))
    .filter(word => !ignoreWords.has(word))
    .join(" ");
}

export function hasPhrase(text, phrase) {
  const cleanText = ` ${normalizeText(text)} `;
  const cleanPhrase = ` ${normalizeText(phrase)} `;
  return cleanPhrase.trim() !== "" && cleanText.includes(cleanPhrase);
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
}

function mergeCountries(primary = [], fallback = []) {
  const merged = new Map();
  for (const country of fallback) merged.set(country.code, country);
  for (const country of primary) {
    if (country?.code && country?.name) merged.set(country.code, country);
  }
  return Array.from(merged.values());
}
