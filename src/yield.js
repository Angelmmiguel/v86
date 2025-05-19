let timeout;
// Function to set a tick to the main thread
globalThis.onmessage = function (c) {
	const t = c.data.t;
	timeout = timeout && clearTimeout(timeout);
	1 > t ? postMessage(c.data.tick) : (timeout = setTimeout(() => postMessage(c.data.tick), t));
};
