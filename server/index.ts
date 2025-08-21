import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { EventEmitter } from 'events'
import dotenv from 'dotenv'
import net from 'net'
import { Logger } from 'simple-tcp-to-wss-common/logger';


/**
 * 
 * @interface SocketClient 
 * @property {string} id - Unique identifier for the client.
 * @property {WebSocket} socket - The WebSocket instance for the client.
 * @property {number} lastActivity - Timestamp of the client's last activity.
 * @property {Map<string, Set<string>>} subscriptions - Map of event names to sets of subscription IDs.
 *
 */
export interface SocketClient {
    id: string
    socket: WebSocket
    lastActivity: number
    subscriptions: Map<string, Set<string>>
}

/**
 * 구독 정보를 나타내는 인터페이스입니다.
 * 
 * @interface Subscription
 * @property {string} clientId - The ID of the client that created the subscription.
 * @property {string} subscriptionId - Unique identifier for the subscription.
 * @property {string} eventName - The name of the event to which the client is subscribed.
 */
export interface Subscription {
    clientId: string
    subscriptionId: string
    eventName: string
}

const env = process.env.NODE_ENV || 'development'

const logger = new Logger(process.env.NODE_ENV === 'development')

dotenv.config({
    path: env === 'development' ? '.env.development' : '.env.production'
})


/**
 * WebSocket 서버 클래스로, TCP 서버와의 연결을 중계하고 클라이언트 연결을 관리합니다.
 * 
 * @extends EventEmitter
 * @example
 * ```typescript
 * const server = new SocketServer();
 * 
 * server.on('clientConnected', ({ clientId, ip }) => {
 *   logger.log(`New client connected: ${clientId} from ${ip}`);
 * });
 * 
 * // 서버 종료
 * server.shutdown();
 * ```
 */
export class SocketServer extends EventEmitter {
    // WebSocket 서버 인스턴스
    wss: WebSocketServer
    clients: Map<string, SocketClient> = new Map()
    subscriptions: Map<string, Subscription> = new Map()
    pingInterval: NodeJS.Timeout | null = null
    debugMode: boolean = true
    nextSubscriptionId: number = 1
    tcpClient: net.Socket | null = null
    tcpReconnectInterval: NodeJS.Timeout | null = null
    tcpReconnectAttempts: number = 0
    maxTcpReconnectAttempts: number = 5
    pingPongInterval: NodeJS.Timeout | null = null

    intervals: Map<string, NodeJS.Timeout> = new Map()


    eventThrottles: Map<string, { lastBroadcast: number, throttleMs: number }> = new Map();
    latestTcpData: any = null
    tcpBroadcastTimer: NodeJS.Timeout | null = null


    /**
     * Logger 인스턴스 (공통)
     */

    /**
     * 기본 WebSocket 이벤트를 설정합니다.
     * @example
     * this.setupDefaultEvents();
     */
    setupDefaultEvents(): void {
        this.on('defaultEvent', ({ value, source }) => {
            logger.client(`CRI data updated to ${value} from ${source}, notifying subscribers`)
            this.notifyEventSubscribers('defaultEvent', value)
        })
    }


    constructor() {
        super()
        const server = createServer()
        this.wss = new WebSocketServer({ server })

        this.setupSocketEvents()
        this.setupDefaultEvents()
        this.startHeartbeat()

        const port = process.env.WS_PORT ? parseInt(process.env.WS_PORT) : 3001
        const tcpHost = process.env.TCP_HOST || 'localhost'
        const tcpPort = process.env.TCP_PORT ? parseInt(process.env.TCP_PORT) : 9000

        this.setupTcpClient(tcpHost, tcpPort)

        server.listen(port, () => {
            logger.success(`WebSocket server started on port ${port}`)
        })
    }

    /**
     * WebSocket 연결 이벤트 및 클라이언트 등록을 처리합니다.
    * @example
    * ```typescript
    * // WebSocket 연결 시 클라이언트 등록 및 이벤트 바인딩
    * this.wss.on('connection', (socket, request) => {
    *   const clientId = this.generateClientId();
    *   this.clients.set(clientId, { id: clientId, socket, lastActivity: Date.now(), subscriptions: new Map() });
    *   this.sendToClient(clientId, 'connection', { success: true, clientId });
    * });
    * ```
     */
    setupSocketEvents(): void {
        this.wss.on('connection', (socket: WebSocket, request) => {
            const clientId = this.generateClientId()
            const ip = request.headers['x-forwarded-for'] || request.socket.remoteAddress

            const client: SocketClient = {
                id: clientId,
                socket,
                lastActivity: Date.now(),
                subscriptions: new Map(),
            }

            this.clients.set(clientId, client)
            logger.client(`Client connected: ${clientId} from ${ip}, Total clients: ${this.clients.size}`)

            this.sendToClient(clientId, 'connection', {
                success: true,
                clientId,
                message: 'Connected to WebSocket Server',
                protocol: {
                    version: '1.0',
                    supportedTransferFormats: ['Text'],
                },
            })

            socket.on('message', (data) => {
                this.handleClientMessage(clientId, data)
            })

            socket.on('close', (code, reason) => {
                logger.client(`Client ${clientId} connection closed with code ${code}, reason: ${reason || 'No reason provided'}`)
                this.handleClientDisconnect(clientId)
            })

            socket.on('error', (error) => {
                console.error(`Socket error for client ${clientId}:`, error)
            })

            this.emit('clientConnected', { clientId, ip })
        })
    }

    /**
     * TCP 서버 연결을 초기화합니다.
     * @param host TCP 서버 호스트명
     * @param port TCP 서버 포트
    * @example
    * ```typescript
    * // TCP 서버 연결 초기화
    * this.setupTcpClient('localhost', 9000);
    * ```
     */
    setupTcpClient(host: string, port: number): void {
        this.connectToTcpServer(host, port)
    }

    /**
     * TCP 서버에 연결합니다.
     * @param host TCP 서버 호스트명
     * @param port TCP 서버 포트
    * @example
    * ```typescript
    * // TCP 서버에 연결
    * this.connectToTcpServer('localhost', 9000);
    * // 연결 후 pingPongInterval 설정
    * this.pingPongInterval = setInterval(() => {
    *   this.sendToTcpServer('Hello TCP Server');
    * }, 5000);
    * ```
     */
    connectToTcpServer(host: string, port: number): void {
        if (this.tcpClient) {
            this.tcpClient.destroy()
        }

        this.tcpClient = new net.Socket()

        this.tcpClient.setNoDelay(true)
        this.tcpClient.setKeepAlive(true, 10000)

        this.tcpClient.connect(port, host, () => {
            logger.tcp(`Connected to TCP server at ${host}:${port}`)
            this.tcpReconnectAttempts = 0

            if (this.tcpReconnectInterval) {
                clearInterval(this.tcpReconnectInterval)
                this.tcpReconnectInterval = null
            }

            this.pingPongInterval = setInterval(() => {
                this.sendToTcpServer('Hello TCP Server')
            }, 5000);
        })

        this.tcpClient.on('data', (data) => {
            const receivedAt = Date.now()
            try {
                this.latestTcpData = {
                    data: null,
                    receivedAt,
                    dataLength: data.length
                }
                this.throttledTcpBroadcast('', null, receivedAt)
            } catch (error) {
                logger.error('Error processing TCP data:', error)
            }
        })
        this.tcpClient.on('close', () => {
            logger.tcp('TCP connection closed')
            this.tcpClient = null
            this.scheduleTcpReconnect(host, port)
        })
        this.tcpClient.on('error', (error: any) => {
            logger.error('TCP connection error:', error)
            logger.tcp(`TCP error details: ${error.message}, code: ${error.code}`)
            switch (error.code) {
                case 'ECONNRESET':
                    logger.tcp('Connection was reset by peer')
                    break
                case 'ETIMEDOUT':
                    logger.tcp('Connection timed out')
                    break
                case 'ECONNREFUSED':
                    logger.tcp('Connection refused by server')
                    break
                default:
                    logger.tcp(`Unknown error: ${error.code}`)
            }
            this.tcpClient = null
            this.scheduleTcpReconnect(host, port)
        })

        this.tcpClient.on('timeout', () => {
            logger.warning('TCP connection timeout')
            this.tcpClient?.destroy()
        })
    }

    /**
     * TCP 재연결을 예약합니다.
     * @param host TCP 서버 호스트명
     * @param port TCP 서버 포트
    * @example
    * ```typescript
    * // 재연결 시도 및 딜레이 적용
    * this.scheduleTcpReconnect('localhost', 9000);
    * ```
     */
    scheduleTcpReconnect(host: string, port: number): void {
        if (this.tcpReconnectAttempts >= this.maxTcpReconnectAttempts) {
            logger.error(`Max TCP reconnection attempts (${this.maxTcpReconnectAttempts}) reached. Stopping reconnection.`)
            return
        }
        if (this.tcpReconnectInterval) {
            clearTimeout(this.tcpReconnectInterval)
            this.tcpReconnectInterval = null
        }
        this.tcpReconnectAttempts++
        const delay = Math.min(1000 * Math.pow(2, this.tcpReconnectAttempts - 1), 30000)

        logger.log(`Scheduling TCP reconnection in ${delay}ms (attempt ${this.tcpReconnectAttempts}/${this.maxTcpReconnectAttempts})`)

        this.tcpReconnectInterval = setTimeout(() => {
            this.tcpReconnectInterval = null
            this.connectToTcpServer(host, port)
        }, delay)
    }

    /**
     * TCP 서버로 데이터를 전송합니다.
     * @param data 전송할 데이터 (string 또는 Buffer)
     * @returns 전송 성공 여부
    * @example
    * ```typescript
    * // TCP 서버로 데이터 전송
    * this.sendToTcpServer('hello');
    * ```
     */
    public sendToTcpServer(data: string | Buffer): boolean {
        if (!this.tcpClient || this.tcpClient.readyState !== 'open') {
            logger.log('TCP client not connected, cannot send data')
            return false
        }

        try {
            if (Buffer.isBuffer(data)) {
                this.tcpClient.write(new Uint8Array(data))
            } else {
                this.tcpClient.write(data)
            }
            logger.log('Data sent to TCP server:', data.toString())
            return true
        } catch (error) {
            console.error('Error sending data to TCP server:', error)
            return false
        }
    }

    /**
     * TCP 데이터 브로드캐스트를 쓰로틀링하여 전송합니다.
     * @param parsedData 파싱된 데이터
     * @param receivedAt 수신 시각 (timestamp)
     * @param eventName 이벤트 이름
    * @example
    * ```typescript
    * // TCP 데이터 수신 시 브로드캐스트
    * this.throttledTcpBroadcast('RobotData', parsedData, receivedAt);
    * ```
     */
    throttledTcpBroadcast(eventName: string, parsedData: any, receivedAt: number): void {
        const now = Date.now()

        const eventThrottle = this.eventThrottles.get(eventName) || { lastBroadcast: 0, throttleMs: 100 };
        if (now - eventThrottle.lastBroadcast >= eventThrottle.throttleMs) {
            this.notifyEventSubscribers(eventName, {
                data: parsedData,
                receivedAt,
                type: 'robot'
            })
            this.eventThrottles.set(eventName, { ...eventThrottle, lastBroadcast: now })
        }
    }




    /**
     * 클라이언트의 이벤트 구독을 처리합니다.
     * @param clientId 클라이언트 ID
     * @param eventName 구독할 이벤트명
     * @param data 추가 데이터(옵션)
     * @returns 구독 ID
    * @example
    * ```typescript
    * // 클라이언트가 이벤트 구독 요청 시
    * const subscriptionId = this.handleSubscription(clientId, 'RobotData');
    * ```
     */
    handleSubscription(clientId: string, eventName: string, data?: any): string {
        const client = this.clients.get(clientId)
        if (!client) throw new Error(`Client ${clientId} not found`)

        const subscriptionId = `sub_${this.nextSubscriptionId++}_${clientId}`

        if (!client.subscriptions.has(eventName)) {
            client.subscriptions.set(eventName, new Set())
        }
        client.subscriptions.get(eventName)!.add(subscriptionId)

        this.subscriptions.set(subscriptionId, {
            clientId,
            subscriptionId,
            eventName,
        })

        logger.log(`Client ${clientId} subscribed to ${eventName} with ID ${subscriptionId}`)

        this.sendToClient(clientId, 'SubscriptionConfirmed', {
            subscriptionId,
            eventName,
            timestamp: Date.now(),
            data,
        })

        return subscriptionId
    }

    /**
     * 클라이언트의 이벤트 구독 해제를 처리합니다.
     * @param clientId 클라이언트 ID
     * @param subscriptionId 구독 ID
     * @returns 성공 여부
    * @example
    * ```typescript
    * // 클라이언트가 구독 해제 요청 시
    * const success = this.handleUnsubscription(clientId, subscriptionId);
    * ```
     */
    handleUnsubscription(clientId: string, subscriptionId: string): boolean {
        const subscription = this.subscriptions.get(subscriptionId)
        if (!subscription || subscription.clientId !== clientId) {
            return false
        }

        this.subscriptions.delete(subscriptionId)

        const client = this.clients.get(clientId)
        if (client) {
            const eventSubscriptions = client.subscriptions.get(subscription.eventName)
            if (eventSubscriptions) {
                eventSubscriptions.delete(subscriptionId)
                if (eventSubscriptions.size === 0) {
                    client.subscriptions.delete(subscription.eventName)
                }
            }
        }

        logger.log(`Client ${clientId} unsubscribed from ${subscription.eventName} (ID: ${subscriptionId})`)
        return true
    }



    /**
     * 클라이언트로부터의 메시지를 처리합니다.
     * @param clientId 클라이언트 ID
     * @param data 수신 데이터
    * @example
    * ```typescript
    * // 클라이언트 메시지 수신 시
    * this.handleClientMessage(clientId, data);
    * ```
     */
    handleClientMessage(clientId: string, data: any): void {
        try {
            const client = this.clients.get(clientId)
            if (!client) {
                console.error(`Message received from unknown client: ${clientId}`)
                return
            }
            client.lastActivity = Date.now()
            const message = JSON.parse(data.toString())

            switch (message.type) {
                case 'Connection':
                    this.handleConnectionParams(clientId, message.data)
                    break
                case 'pong':
                    break
                case 'Subscribe':
                    try {
                        const subscriptionId = this.handleSubscription(clientId, message.data.eventName, message.data.options)
                        if (message.data.eventName === 'UpdateCRI') {
                            this.sendToClient(clientId, 'UpdateCRI', null)
                        }
                    } catch (error) {
                        console.error(`Error handling subscription for client ${clientId}:`, error)
                    }
                    break
                case 'Unsubscribe':
                    const success = this.handleUnsubscription(clientId, message.data.subscriptionId)
                    this.sendToClient(clientId, 'UnsubscriptionResult', {
                        subscriptionId: message.data.subscriptionId,
                        success,
                    })
                    break
                default:
                    logger.log(`Unhandled message type from client ${clientId}:`, message.type)
            }
        } catch (error) {
            console.error(`Error processing message from client ${clientId}:`, error)
        }
    }

    /**
     * 클라이언트 연결 파라미터를 처리합니다.
     * @param clientId 클라이언트 ID
     * @param params 파라미터 객체
    * @example
    * ```typescript
    * // Connection 메시지 타입 처리
    * this.handleConnectionParams(clientId, params);
    * ```
     */
    handleConnectionParams(clientId: string, params: any): void {
        logger.log(`Connection parameters received from client ${clientId}:`, params)
    }
    /**
     * 이벤트 구독자에게 데이터를 전송합니다.
     * @param eventName 이벤트명
     * @param data 전송 데이터
    * @example
    * ```typescript
    * // 이벤트 구독자에게 데이터 전송
    * this.notifyEventSubscribers('RobotData', { foo: 1 });
    * ```
     */
    notifyEventSubscribers(eventName: string, data: any): void {
        let notifiedCount = 0
        for (const [clientId, client] of Array.from(this.clients.entries())) {
            if (client.subscriptions.has(eventName)) {
                this.sendToClient(clientId, eventName, data)
                notifiedCount++
            }
        }
        if (notifiedCount > 0) {
            logger.log(`Notified ${notifiedCount} subscribers of event '${eventName}'`)
        }
    }

    /**
     * 클라이언트 연결 해제를 처리합니다.
     * @param clientId 클라이언트 ID
    * @example
    * ```typescript
    * // 클라이언트 연결 해제 시
    * this.handleClientDisconnect(clientId);
    * ```
     */
    handleClientDisconnect(clientId: string): void {
        const client = this.clients.get(clientId)

        if (client) {
            this.broadcast('UserLeft', {
                clientId,
                timestamp: Date.now(),
            })
        }

        if (client) {
            const subscriptionIds: string[] = []
            client.subscriptions.forEach((subIds) => {
                subIds.forEach((id) => subscriptionIds.push(id))
            })

            subscriptionIds.forEach((id) => {
                this.subscriptions.delete(id)
            })
        }

        this.clients.delete(clientId)
        logger.log(`Client disconnected: ${clientId}, Remaining clients: ${this.clients.size}`)
    }

    /**
     * 클라이언트에게 메시지를 전송합니다.
     * @param clientId 클라이언트의 고유 ID
     * @param type 메시지 타입
     * @param data 전송할 데이터
     * @example
     * this.sendToClient('client_1', 'message', { text: 'Hello' });
     */
    sendToClient(clientId: string, type: string, data: any): void {
        const client = this.clients.get(clientId)
        if (!client) return
        try {
            const message = JSON.stringify({ type, data })
            client.socket.send(message)
            if (type !== 'ping') {
                logger.log(`Message sent to client ${clientId}: ${type}`)
            }
        } catch (error) {
            console.error(`Error sending message to client ${clientId}:`, error)
        }
    }

    /**
     * 모든 클라이언트에게 메시지를 브로드캐스트합니다.
     * @param type 메시지 타입
     * @param data 전송할 데이터
     * @param excludeClientIds 제외할 클라이언트 ID 목록
     * @example
     * this.broadcast('notice', { text: '서버 재시작' });
     */
    broadcast(type: string, data: any, excludeClientIds: string[] = []): void {
        let sentCount = 0
        for (const [id, _] of Array.from(this.clients.entries())) {
            if (!excludeClientIds.includes(id)) {
                this.sendToClient(id, type, data)
                sentCount++
            }
        }
        if (type !== 'ping') {
            logger.log(`Broadcast ${type} sent to ${sentCount} clients`)
        }
    }

    /**
     * 클라이언트 ID를 생성합니다.
     * @returns 생성된 클라이언트 ID
     * @example
     * const id = this.generateClientId();
     */
    generateClientId(): string {
        return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    }

    /**
     * 하트비트(heartbeat) 체크를 시작합니다.
     * @example
     * this.startHeartbeat();
     */
    startHeartbeat(): void {
        this.pingInterval = setInterval(() => {
            const now = Date.now()
            let activeClients = 0
            let inactiveClients = 0

            for (const [id, client] of Array.from(this.clients.entries())) {
                if (now - client.lastActivity > 30000) {
                    inactiveClients++
                    try {
                        client.socket.send(JSON.stringify({ type: 'ping', timestamp: now }))

                        if (now - client.lastActivity > 120000) {
                            logger.log(
                                `Client ${id} inactive for too long (${((now - client.lastActivity) / 1000).toFixed(0)}s), terminating connection`,
                            )
                            client.socket.terminate()
                            this.clients.delete(id)
                            this.emit('clientTimedOut', { clientId: id })
                        }
                    } catch (error) {
                        console.error(`Error pinging client ${id}:`, error)
                        this.clients.delete(id)
                    }
                } else {
                    activeClients++
                }
            }

            if (this.clients.size > 0) {
                logger.log(`Heartbeat check: ${activeClients} active, ${inactiveClients} inactive clients`)
            }
        }, 30000)
    }

    /**
     * 서버를 안전하게 종료합니다.
     * @example
     * this.shutdown();
     */
    public shutdown(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval)
        }

        if (this.tcpBroadcastTimer) {
            clearTimeout(this.tcpBroadcastTimer)
            this.tcpBroadcastTimer = null
        }

        if (this.tcpReconnectInterval) {
            clearInterval(this.tcpReconnectInterval)
            this.tcpReconnectInterval = null
        }

        if (this.pingPongInterval) {
            clearInterval(this.pingPongInterval)
            this.pingPongInterval = null
        }

        if (this.tcpClient) {
            this.tcpClient.destroy()
            this.tcpClient = null
        }

        for (const [_, client] of Array.from(this.clients.entries())) {
            try {
                client.socket.close()
            } catch (error) {
            }
        }

        this.wss.close()
        logger.log('WebSocket server shut down')

        this.emit('serverShutdown')
    }
}

if (require.main === module) {
    const socketServer = new SocketServer()

    process.on('SIGINT', () => {
        logger.error('[SERVER] Received SIGINT. Shutting down WebSocket server...')
        socketServer.shutdown()
        process.exit(0)
    })

    process.on('SIGTERM', () => {
        logger.error('[SERVER] Received SIGTERM. Shutting down WebSocket server...')
        socketServer.shutdown()
        process.exit(0)
    })
}
