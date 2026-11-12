# FolioPatent

Full patent analysis in the browser. Enter a publication number or upload a PDF.

The report covers inventors, owners, claims, technologies, chemical compounds, polymers, organisms, cited patents, dates, filing office, foreign filings, related cases, and abstract translation.

## Server environment

Set these on the host (Vercel project settings). Do not prefix them with `VITE_`.

- `SERPAPI_API_KEY` — Google Patents details through SerpApi
- `USPTO_API_KEY` — USPTO Open Data Portal
- `EPO_CONSUMER_KEY` and `EPO_CONSUMER_SECRET` — optional, once EPO access is approved

Without those, lookup uses the public patent page. PDFs are read in the browser.
