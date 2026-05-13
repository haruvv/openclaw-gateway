#!/usr/bin/env node
/**
 * dev-team/scripts/get-task.js
 * Check the status of a dev team task.
 */

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

const taskId = getArg('--task-id');

const baseUrl = process.env.DEV_TEAM_MCP_URL
  ? process.env.DEV_TEAM_MCP_URL.replace(/\/mcp$/, '')
  : null;
const token = process.env.DEV_TEAM_MCP_TOKEN;

if (!taskId) {
  console.error('Error: --task-id is required');
  process.exit(1);
}
if (!baseUrl || !token) {
  console.error('Error: DEV_TEAM_MCP_URL and DEV_TEAM_MCP_TOKEN env vars are required');
  process.exit(1);
}

async function main() {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Error ${res.status}: ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  console.log(JSON.stringify(data));
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
