import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  const host = request.params?.arguments?.__host_codex_context || {};
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    result: {
      pid: process.pid,
      worker_thread: host.thread_id || null,
      tool: request.params?.name || null,
    },
  })}\n`);
}
