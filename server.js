const mediasoup = require("mediasoup");
const fs = require("fs");
const https = require("https");
const http = require("http");
const express = require("express");
const socketIO = require("socket.io");
const config = require("./config");

// Global variables
let worker;
let webServer;
let socketServer;
let expressApp;
let producer;
let consumer;
let producerTransport;
let consumerTransport;
let mediasoupRouter;

(async () => {
  try {
    await runExpressApp();
    await runWebServer();
    await runSocketServer();
    await runMediasoupWorker();
  } catch (err) {
    console.error(err);
  }
})();

async function runExpressApp() {
  expressApp = express();
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname));

  expressApp.use((error, req, res, next) => {
    if (error) {
      console.warn("Express app error,", error.message);

      error.status = error.status || (error.name === "TypeError" ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });
}

async function runWebServer() {
  const { listenIp, listenPort } = config;
  webServer = http.createServer(expressApp);
  webServer.on("error", (err) => {
    console.error("starting web server failed:", err.message);
  });

  await new Promise((resolve) => {
    webServer.listen(listenPort, listenIp, () => {
      console.log("server is running");
      console.log(`open http://${listenIp}:${listenPort} in your web browser`);
      resolve();
    });
  });
}

async function runSocketServer() {
  socketServer = socketIO(webServer, {
    serveClient: false,
    path: "/server",
    log: false,
  });

  socketServer.on("connection", (socket) => {
    console.log("client connected");

    // inform the client about existence of producer
    if (producer) {
      socket.emit("newProducer");
    }

    socket.on("disconnect", () => {
      console.log("client disconnected");
    });

    socket.on("connect_error", (err) => {
      console.error("client connection error", err);
    });

    socket.on("getRouterRtpCapabilities", (data, callback) => {
      callback(mediasoupRouter.rtpCapabilities);
    });

    socket.on("createProducerTransport", async (data, callback) => {
      try {
        const { transport, params } = await createWebRtcTransport();
        producerTransport = transport;
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on("createConsumerTransport", async (data, callback) => {
      console.log("createConsumerTransport");

      try {
        const { transport, params } = await createWebRtcTransport();
        consumerTransport = transport;
        console.log("consumerTransport");
        console.log(consumerTransport);
        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on("connectProducerTransport", async (data, callback) => {
      await producerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on("connectConsumerTransport", async (data, callback) => {
      await consumerTransport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on("produce", async (data, callback) => {
      const { kind, rtpParameters } = data;
      producer = await producerTransport.produce({ kind, rtpParameters });
      callback({ id: producer.id });
      console.log("producer");
      console.log(producer);
      console.log("producer.id");
      console.log(producer.id);
      // inform clients about new producer
      socket.broadcast.emit("newProducer");
    });

    socket.on("consume", async (data, callback) => {
      callback(await createConsumer(producer, data.rtpCapabilities));
    });

    socket.on("resume", async (data, callback) => {
      await consumer.resume();
      callback();
    });
  });
}

async function runMediasoupWorker() {
  worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on("died", () => {
    console.error(
      "mediasoup worker died, exiting in 2 seconds... [pid:%d]",
      worker.pid
    );
    setTimeout(() => process.exit(1), 2000);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  mediasoupRouter = await worker.createRouter({ mediaCodecs });
}

async function createWebRtcTransport() {
  console.log("createWebRtcTransport");

  const { maxIncomingBitrate, initialAvailableOutgoingBitrate } =
    config.mediasoup.webRtcTransport;

  const transport = await mediasoupRouter.createWebRtcTransport({
    listenIps: config.mediasoup.webRtcTransport.listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate,
  });
  if (maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    } catch (error) {}
  }
  console.log("transport");
  console.log(transport);
  console.log("transport.id");
  console.log(transport.id);

  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    },
  };
}

async function createConsumer(producer, rtpCapabilities) {
  console.log("createConsumer");

  if (
    !mediasoupRouter.canConsume({
      producerId: producer.id,
      rtpCapabilities,
    })
  ) {
    console.error("can not consume");
    return;
  }
  try {
    consumer = await consumerTransport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: producer.kind === "video",
    });
  } catch (error) {
    console.error("consume failed", error);
    return;
  }

  if (consumer.type === "simulcast") {
    await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 2 });
  }

  console.log("consumer");
  console.log(consumer);
  console.log("producer.id");
  console.log(producer.id);
  console.log("consumer.id");
  console.log(consumer.id);
  console.log("consumer.kind");
  console.log(consumer.kind);

  return {
    producerId: producer.id,
    id: consumer.id,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    type: consumer.type,
    producerPaused: consumer.producerPaused,
  };
}
