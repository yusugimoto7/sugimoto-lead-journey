// Entry of the static build's browser bundle: the same answers as the server, on the decoded data file.
const { decode } = require('../lib/pack');
const { run, ROUTES } = require('../lib/routes');
window.LJ = { decode, run, routes: Object.keys(ROUTES) };
