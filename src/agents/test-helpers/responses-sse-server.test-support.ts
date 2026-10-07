import { createServer, type Server } from "node:http";

export async function createResponsesSseServer(...events: Record<string, unknown>[]): Promise<{
  server: Server;
  baseUrl: string;
  requestPaths: string[];
}> {
  const requestPaths: string[] = [];
  const server = createServer((request, response) => {
    requestPaths.push(request.url ?? "");
    request.resume();
    request.on("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for (const event of events) {
        response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Missing Responses loopback server address");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, requestPaths };
}

export async function closeResponsesSseServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
