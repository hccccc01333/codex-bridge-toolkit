import { readWebDelivery } from "../scripts/control_plane.mjs";

const delivery = readWebDelivery(process.argv[2]);
process.stdout.write(`${JSON.stringify(delivery)}\n`);
