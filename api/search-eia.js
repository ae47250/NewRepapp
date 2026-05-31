export default async function handler(req, res) {
  const query = req.query.q;

  if (!query) {
    return res.status(400).json({
      error: "Missing search query. Use ?q=your search terms"
    });
  }

  const apiKey = process.env.EIA_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Missing EIA_API_KEY environment variable in Vercel."
    });
  }

  try {
    const url =
      "https://api.eia.gov/v2/search/?" +
      "api_key=" + encodeURIComponent(apiKey) +
      "&query=" + encodeURIComponent(query);

    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).json({
        error: "EIA API request failed",
        status: response.status
      });
    }

    const data = await response.json();

    return res.status(200).json({
      query: query,
      source: "U.S. Energy Information Administration API",
      results: data
    });

  } catch (error) {
    return res.status(500).json({
      error: "Server error while contacting EIA API",
      details: error.message
    });
  }
}
