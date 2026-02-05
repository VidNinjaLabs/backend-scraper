const {
  makeProviders,
  makeStandardFetcher,
  targets,
} = require("../lib/index.umd.cjs");
const fetch = require("node-fetch");

const customFetch = (url, options = {}) => {
  return fetch(url, { ...options });
};

try {
  console.log("Testing Lib Import...");
  const providers = makeProviders({
    fetcher: makeStandardFetcher(customFetch),
    target: targets.ANY,
    consistentIpForRequests: true,
    externalSources: "all",
  });

  const sources = providers.listSources().map((s) => s.id);
  console.log(`Successfully loaded ${sources.length} sources from LIB!`);
  console.log("Sources:", sources.join(", "));
  process.exit(0);
} catch (err) {
  console.error("LIB VERIFICATION FAILED:", err);
  process.exit(1);
}
