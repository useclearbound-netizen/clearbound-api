// api/engine/index.js
// Unified exports (fixes compute/export mismatch)

const { computeEngineDecisions } = require("./compute");
const { loadPrompt } = require("./promptLoader");

module.exports = {
  computeEngineDecisions,
  loadPrompt
};
