import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

/// A mock Gateway reports the transport's typed pre-dispatch TLS failure. Storage uses the
/// existing in-memory fixture, never platform trust evaluation or the operator's Keychain.
private final class AutomaticPinRenewalFixture: @unchecked Sendable {
    let url = URL(string: "wss://gateway.example.ts.net")!
    let storeKey = "automatic-renewal-\(UUID().uuidString)"
    let configured: Bool
    let renewed = LockIsolated(false)
    let requests = LockIsolated<[String]>([])
    let sockets = LockIsolated<[GatewayTestWebSocketTask]>([])
    let handshakes: AsyncStream<Bool>
    private let handshakeContinuation: AsyncStream<Bool>.Continuation

    init(configured: Bool = false) {
        self.configured = configured
        (self.handshakes, self.handshakeContinuation) = AsyncStream<Bool>.makeStream()
        GatewayTLSStore.saveFingerprint("old", stableID: self.storeKey)
    }

    func endpoint(token: String? = nil) throws -> GatewayConnection.EndpointSnapshot {
        let route = try #require(GatewayTLSRoute.resolve(
            url: self.url,
            connectionMode: .remote,
            configuredFingerprint: self.configured ? "old" : nil,
            storeKey: self.storeKey))
        return GatewayConnection.EndpointSnapshot(
            config: (url: self.url, token: token, password: nil),
            tls: route,
            routeAuthority: nil)
    }

    func connection(endpointProvider: GatewayConnection.EndpointProvider? = nil) -> GatewayConnection {
        GatewayConnection(
            testEndpointProvider: endpointProvider ?? { try self.endpoint() },
            sessionProvider: { route in route.map(self.sessionBox) })
    }

    func finish() {
        self.handshakeContinuation.finish()
    }

    private func sessionBox(route: GatewayTLSRoute) -> WebSocketSessionBox {
        let session = GatewayTestWebSocketSession(taskFactory: {
            let socket = GatewayTestWebSocketTask(
                sendHook: { socket, message, index in
                    guard index > 0,
                          let method = GatewayWebSocketTestSupport.requestMethod(from: message),
                          let id = GatewayWebSocketTestSupport.requestID(from: message)
                    else { return }
                    self.requests.withValue { $0.append(method) }
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                },
                receiveHook: { socket, index in
                    if index == 0 {
                        if self.renewed.value, route.params.expectedFingerprint != "new" {
                            self.handshakeContinuation.yield(false)
                            throw GatewayTLSValidationError(
                                failure: GatewayTLSValidationFailure(
                                    kind: .pinMismatch,
                                    host: "gateway.example.ts.net",
                                    storeKey: self.storeKey,
                                    expectedFingerprint: route.params.expectedFingerprint,
                                    observedFingerprint: "new",
                                    systemTrustOk: true,
                                    port: 443),
                                context: "automatic renewal fixture")
                        }
                        return .data(GatewayWebSocketTestSupport.connectChallengeData())
                    }
                    self.handshakeContinuation.yield(true)
                    return .data(GatewayWebSocketTestSupport.connectOkData(
                        id: socket.snapshotConnectRequestID() ?? "connect"))
                })
            self.sockets.withValue { $0.append(socket) }
            return socket
        })
        return WebSocketSessionBox(session: session)
    }
}

struct GatewayAutomaticPinRenewalTests {
    @Test(.gatewayTLSStoreIsolated, arguments: [false, true])
    func `automatic reconnect renews only learned pins without a new RPC`(configured: Bool) async throws {
        let fixture = AutomaticPinRenewalFixture(configured: configured)
        defer { fixture.finish() }
        let connection = fixture.connection()
        let pushes = await connection.subscribe()
        let result: Result<Void, Error>
        do {
            _ = try await connection.request(method: "health", params: nil)
            fixture.renewed.withValue { $0 = true }
            try #require(fixture.sockets.value.last).emitReceiveFailure()
            try await AsyncTimeout.withTimeout(seconds: 5, onTimeout: { URLError(.timedOut) }) {
                if configured {
                    for await accepted in fixture.handshakes where !accepted {
                        return
                    }
                } else {
                    for await delivery in pushes {
                        if case .push(.snapshot) = delivery.event,
                           delivery.serverLease.route.tls?.params.expectedFingerprint == "new"
                        { return }
                    }
                }
                throw CancellationError()
            }
            #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) == (configured ? "old" : "new"))
            #expect(fixture.requests.value == ["health"])
            result = .success(())
        } catch { result = .failure(error) }
        await connection.shutdown()
        try result.get()
    }

    @Test(.gatewayTLSStoreIsolated)
    func `delayed TLS failure cannot renew a route whose credentials changed`() async throws {
        let fixture = AutomaticPinRenewalFixture()
        defer { fixture.finish() }
        fixture.renewed.withValue { $0 = true }
        let endpointReads = LockIsolated(0)
        let currentToken = LockIsolated<String?>(nil)
        let repairResolving = AsyncTestGate()
        let resumeResolution = AsyncTestGate()
        let connection = fixture.connection(endpointProvider: {
            let count = endpointReads.withValue { $0 += 1
                return $0
            }
            if count == 2 {
                repairResolving.open()
                await resumeResolution.wait()
            }
            return try fixture.endpoint(token: currentToken.value)
        })
        let request = Task { try await connection.request(method: "health", params: nil) }
        let result: Result<Void, Error>
        do {
            try await AsyncTimeout.withTimeout(seconds: 5, onTimeout: { URLError(.timedOut) }) {
                await repairResolving.wait()
            }
            currentToken.withValue { $0 = "replacement-test-token" }
            resumeResolution.open()
            do {
                _ = try await request.value
                Issue.record("a stale TLS failure must not repair and retry replacement credentials")
            } catch is CancellationError {}
            #expect(GatewayTLSStore.loadFingerprint(stableID: fixture.storeKey) == "old")
            #expect(fixture.requests.value.isEmpty)
            result = .success(())
        } catch { result = .failure(error) }
        resumeResolution.open()
        request.cancel()
        _ = await request.result
        await connection.shutdown()
        try result.get()
    }
}
