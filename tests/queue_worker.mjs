import fs from "node:fs";
import { enqueueRouteAction } from "../scripts/control_plane.mjs";

const [routeId, logPath] = process.argv.slice(2);
const append = phase => fs.appendFileSync(logPath, `${JSON.stringify({ phase, pid: process.pid, time: Date.now() })}\n`, "utf8");

await enqueueRouteAction(routeId, `worker-${process.pid}`, async () => {
  append("start");
  await new Promise(resolve => setTimeout(resolve, 120));
  append("end");
});
