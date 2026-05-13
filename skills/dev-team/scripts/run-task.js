#!/usr/bin/env node
/**
 * dev-team/scripts/run-task.js
 * Delegate a development task to the dev team via REST API.
 */

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : null;
}

const spec = getArg('--spec');
const callbackUrl = getArg('--callback-url') || process.env.OPENCLAW_GATEWAY_URL || '';
const callbackToken = getArg('--callback-token') || process.env.OPENCLAW_GATEWAY_TOKEN || '';
const label = getArg('--label') || undefined;

const baseUrl = process.env.DEV_TEAM_MCP_URL
  ? process.env.DEV_TEAM_MCP_URL.replace(/\/mcp$/, '')
  : null;
const token = process.env.DEV_TEAM_MCP_TOKEN;

if (!spec) {
  console.error('Error: --spec is required');
  process.exit(1);
}
if (!baseUrl || !token) {
  console.error('Error: DEV_TEAM_MCP_URL and DEV_TEAM_MCP_TOKEN env vars are required');
  process.exit(1);
}
if (!callbackUrl || !callbackToken) {
  console.error('Error: --callback-url and --callback-token are required');
  process.exit(1);
}

async function main() {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      spec,
      callback_url: callbackUrl,
      callback_token: callbackToken,
      task_label: label,
    }),
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
