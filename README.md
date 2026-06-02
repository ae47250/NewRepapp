# EIA Country Energy Search

This is a small GitHub + Vercel web app that searches country-level energy data from the U.S. Energy Information Administration API.

The public webpage lets a user type a plain-language request such as:

- `Brazil energy consumption`
- `Jordan electricity generation`
- `Mexico natural gas production`
- `Japan oil consumption`

The Vercel backend keeps the EIA API key private, calls the EIA API, identifies the country and likely energy concept, returns observations, computes coverage from the actual returned data, displays a graph, and lets the user download the selected series as CSV.

## File structure

```text
index.html
README.md
package.json
api/
  search-eia.js
  interpret-query.js
```

## What each file does

### `index.html`

The public webpage. It contains the search box, result cards, graph, observation table, matching-variable table, CSV download button, and short About section.

### `api/search-eia.js`

The main Vercel backend function. It reads the hidden `EIA_API_KEY`, calls the EIA API, identifies the country, searches EIA international energy data, computes coverage from actual observations, caches repeated API calls, and returns JSON to the webpage.

### `api/interpret-query.js`

The query interpreter. It reads plain-language requests and identifies the likely country, fuel/product type, activity type, and frequency.

### `package.json`

Project metadata. It declares `type: module` so Node and Vercel treat the JavaScript API route files as ES modules.

### `README.md`

This file. It documents the project and setup steps.

## Required Vercel environment variable

Add this environment variable in Vercel:

```text
EIA_API_KEY=your_actual_eia_api_key_here
```

Do not paste the EIA API key into `index.html`. Do not commit the key to GitHub.

## GitHub setup

1. Create a GitHub repository.
2. Add `index.html` in the root of the repository.
3. Add `README.md` in the root of the repository.
4. Add `package.json` in the root of the repository.
5. Create an `api` folder.
6. Add `search-eia.js` inside `api`.
7. Add `interpret-query.js` inside `api`.
8. Commit the files.

The repository should look exactly like this:

```text
index.html
README.md
package.json
api/search-eia.js
api/interpret-query.js
```

## Vercel setup

1. Go to Vercel.
2. Import the GitHub repository.
3. Use the default build settings.
4. Add the environment variable `EIA_API_KEY`.
5. Deploy.

Vercel will serve `index.html` as the website and the files inside `api` as backend routes.

## Smoke tests

After deploying, these full web addresses should return JSON:

```text
https://eia-data-search.vercel.app/api/interpret-query?q=Brazil%20energy%20consumption
https://eia-data-search.vercel.app/api/search-eia?q=Brazil%20energy%20consumption
```

The homepage should also accept the search phrase `Brazil energy consumption` and display a selected series, chart, observations, and matching variables.

## Backend routes

### `/api/search-eia`

Main route used by the webpage.

Example:

```text
/api/search-eia?q=Brazil%20energy%20consumption
```

Useful query parameters:

```text
q          Plain-language search query
country    Optional country code or country name
productId  Optional EIA productId for exact series selection
activityId Optional EIA activityId for exact series selection
unit       Optional EIA unit facet for exact series selection
```

### `/api/interpret-query`

Helper route that returns the interpreted query intent.

Example:

```text
/api/interpret-query?q=Brazil%20energy%20consumption
```

## Main features

- Natural-language query interpretation.
- Single-country EIA international energy search.
- CSV download for selected series.
- Coverage calculation from actual returned observations.
- Backend caching to reduce repeated EIA API calls.
- User-friendly error messages.
- About-this-data section on the webpage.

This version intentionally does not include multi-country comparison mode and does not add a separate advanced relevance-ranking system.

## Important troubleshooting notes

If the homepage does not load, confirm the file is named exactly:

```text
index.html
```

and that it is in the repository root.

If the backend route does not work, confirm the backend files are located exactly here:

```text
api/search-eia.js
api/interpret-query.js
```

If you see a missing key error, add `EIA_API_KEY` in Vercel Environment Variables and redeploy.

If the live site does not update after editing GitHub, check the latest Vercel deployment and hard-refresh the live site after deployment finishes.

If variable coverage looks wrong, use this version. It computes displayed coverage from actual returned observations for each displayed series, not just from the partial broad search list.
