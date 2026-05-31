export default async function handler(req, res) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-5.5";
  const query = getQuery(req);

  if (!query) {
    return res.status(400).json({
      error: "Missing query. Example: Brazil energy consumption."
    });
  }

  if (!apiKey) {
    return res.status(200).json({
      originalQuery: query,
      searchQuery: query,
      aiUsed: false,
      warning: "Missing OPENAI_API_KEY environment variable in Vercel. Used original query instead."
    });
  }

  try {
    const prompt = buildPrompt(query);

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model,
        input: prompt,
        store: false
      })
    });

    const text = await response.text();
    let json;

    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("OpenAI returned non-JSON response: " + text.slice(0, 300));
    }

    if (!response.ok) {
      const message = json?.error?.message || json?.error || "OpenAI API request failed.";
      throw new Error(message);
    }

    const outputText = extractOutputText(json);
    const interpreted = parseJsonObject(outputText);
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

function buildPrompt(query) {
  return [
    {
      role: "system",
      content:
        "You interpret user searches for the U.S. Energy Information Administration API. " +
        "Return only valid JSON. Do not include markdown. Do not invent data. " +
        "Focus on country-level international energy searches. " +
        "Your job is to convert casual language into a clean EIA search phrase. " +
        "Examples: 'power use in Jordan' means 'Jordan electricity consumption'. " +
        "'oil use in Egypt' means 'Egypt petroleum consumption'. " +
        "'gas production Brazil' means 'Brazil natural gas production'. " +
        "If the user says gas and it is unclear whether they mean gasoline or natural gas, choose natural gas unless gasoline prices are clearly implied."
    },
    {
      role: "user",
      content:
        "Interpret this query and return JSON with these fields: " +
        "originalQuery, searchQuery, country, countryIso, topic, product, activity, frequency, observations, needsClarification, clarificationQuestion. " +
        "The searchQuery should be a short phrase suitable for keyword search by the existing EIA backend. " +
        "Use annual frequency unless the user clearly asks otherwise. " +
        "Use 10 observations if the user asks for recent/latest/last decade, otherwise use null. " +
        "Query: " + query
    }
  ];
}

function extractOutputText(responseJson) {
  if (typeof responseJson.output_text === "string") {
    return responseJson.output_text;
  }

  if (Array.isArray(responseJson.output)) {
    const parts = [];

    for (const item of responseJson.output) {
      if (!Array.isArray(item.content)) continue;

      for (const contentItem of item.content) {
        if (typeof contentItem.text === "string") {
          parts.push(contentItem.text);
        }
      }
    }

    return parts.join("\n").trim();
  }

  return "";
}

function parseJsonObject(text) {
  const cleaned = String(text || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Could not find a JSON object in the AI response.");
  }

  return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
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
    frequency: cleanString(interpreted.frequency) || "annual",
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
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number);
}
