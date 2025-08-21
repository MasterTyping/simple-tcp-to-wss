import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { EventEmitter } from 'events'
import dotenv from 'dotenv'
import net from 'net'
import { colorize } from 'simple-tcp-to-wss-common';


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
 *   console.log(`New client connected: ${clientId} from ${ip}`);
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

    robotThrottleMs: number = 16
    mobileThrottleMs: number = 16
    criThrottleMs: number = 100
    lastCriBroadcast: number = 0
    lastRobotBroadcast: number = 0
    lastMobileBroadcast: number = 0
    latestTcpData: any = null
    tcpBroadcastTimer: NodeJS.Timeout | null = null

    /**
     * 서버의 로그를 출력합니다.
     * @param args 로그로 출력할 값들 console.log 와 사용법이 같다
     * @example
     * ``` typescript
     * this.log('서버 시작');
     * ```
     */
    log(...args: any[]): void {
        if (this.debugMode) {
            const timestamp = colorize.debug(new Date().toISOString())
            const serverTag = colorize.server('[SERVER]')
            const msg = colorize.info(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
            console.log(`${serverTag} ${timestamp}`, msg)
        }
    }

    /**
     * 에러 로그를 출력합니다.
     * @param args 에러로 출력할 값들
     * @example
     * this.logError('에러 발생', error);
     */
    logError(...args: any[]): void {
        const timestamp = colorize.debug(new Date().toISOString())
        const errorTag = colorize.error('[ERROR]')
        const msg = colorize.error(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        console.error(`${errorTag} ${timestamp}`, msg)
    }

    /**
     * TCP 관련 로그를 출력합니다.
     * @param args TCP 로그로 출력할 값들
     * @example
     * this.logTcp('TCP 연결됨');
     */
    logTcp(...args: any[]): void {
        if (this.debugMode) {
            const timestamp = colorize.debug(new Date().toISOString())
            const tcpTag = colorize.tcp('[TCP]')
            const msg = colorize.tcp(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
            console.log(`${tcpTag} ${timestamp}`, msg)
        }
    }

    /**
     * 클라이언트 관련 로그를 출력합니다.
     * @param args 클라이언트 로그로 출력할 값들
     * @example
     * this.logClient('클라이언트 접속', clientId);
     */
    logClient(...args: any[]): void {
        if (this.debugMode) {
            const timestamp = colorize.debug(new Date().toISOString())
            const clientTag = colorize.client('[CLIENT]')
            const msg = colorize.client(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
            console.log(`${clientTag} ${timestamp}`, msg)
        }
    }

    /**
     * 성공 로그를 출력합니다.
     * @param args 성공 로그로 출력할 값들
     * @example
     * this.logSuccess('서버가 성공적으로 시작됨');
     */
    logSuccess(...args: any[]): void {
        const timestamp = colorize.debug(new Date().toISOString())
        const successTag = colorize.success('[SUCCESS]')
        const msg = colorize.success(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        console.log(`${successTag} ${timestamp}`, msg)
    }

    /**
     * 경고 로그를 출력합니다.
     * @param args 경고 로그로 출력할 값들
     * @example
     * this.logWarning('메모리 사용량 높음');
     */
    logWarning(...args: any[]): void {
        const timestamp = colorize.debug(new Date().toISOString())
        const warningTag = colorize.warning('[WARNING]')
        const msg = colorize.warning(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        console.log(`${warningTag} ${timestamp}`, msg)
    }

    /**
     * 기본 WebSocket 이벤트를 설정합니다.
     * @example
     * this.setupDefaultEvents();
     */
    setupDefaultEvents(): void {
        this.on('defaultEvent', ({ value, source }) => {
            this.logClient(`CRI data updated to ${value} from ${source}, notifying subscribers`)
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
            this.logSuccess(`WebSocket server started on port ${port}`)
        })
    }

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
            this.logClient(`Client connected: ${clientId} from ${ip}, Total clients: ${this.clients.size}`)

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
                this.logClient(`Client ${clientId} connection closed with code ${code}, reason: ${reason || 'No reason provided'}`)
                this.handleClientDisconnect(clientId)
            })

            socket.on('error', (error) => {
                console.error(`Socket error for client ${clientId}:`, error)
            })

            this.emit('clientConnected', { clientId, ip })
        })
    }

    setupTcpClient(host: string, port: number): void {
        this.connectToTcpServer(host, port)
    }

    connectToTcpServer(host: string, port: number): void {
        if (this.tcpClient) {
            this.tcpClient.destroy()
        }

        this.tcpClient = new net.Socket()

        this.tcpClient.setNoDelay(true)
        this.tcpClient.setKeepAlive(true, 10000)

        this.tcpClient.connect(port, host, () => {
            this.logTcp(`Connected to TCP server at ${host}:${port}`)
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
                this.throttledTcpBroadcast(null, receivedAt)
            } catch (error) {
                this.logError('Error processing TCP data:', error)
            }
        })
        this.tcpClient.on('close', () => {
            this.logTcp('TCP connection closed')
            this.tcpClient = null
            this.scheduleTcpReconnect(host, port)
        })
        this.tcpClient.on('error', (error: any) => {
            this.logError('TCP connection error:', error)
            this.logTcp(`TCP error details: ${error.message}, code: ${error.code}`)
            switch (error.code) {
                case 'ECONNRESET':
                    this.logTcp('Connection was reset by peer')
                    break
                case 'ETIMEDOUT':
                    this.logTcp('Connection timed out')
                    break
                case 'ECONNREFUSED':
                    this.logTcp('Connection refused by server')
                    break
                default:
                    this.logTcp(`Unknown error: ${error.code}`)
            }
            this.tcpClient = null
            this.scheduleTcpReconnect(host, port)
        })

        this.tcpClient.on('timeout', () => {
            this.logWarning('TCP connection timeout')
            this.tcpClient?.destroy()
        })
    }

    scheduleTcpReconnect(host: string, port: number): void {
        if (this.tcpReconnectAttempts >= this.maxTcpReconnectAttempts) {
            this.logError(`Max TCP reconnection attempts (${this.maxTcpReconnectAttempts}) reached. Stopping reconnection.`)
            return
        }
        if (this.tcpReconnectInterval) {
            clearTimeout(this.tcpReconnectInterval)
            this.tcpReconnectInterval = null
        }
        this.tcpReconnectAttempts++
        const delay = Math.min(1000 * Math.pow(2, this.tcpReconnectAttempts - 1), 30000)

        this.log(`Scheduling TCP reconnection in ${delay}ms (attempt ${this.tcpReconnectAttempts}/${this.maxTcpReconnectAttempts})`)

        this.tcpReconnectInterval = setTimeout(() => {
            this.tcpReconnectInterval = null
            this.connectToTcpServer(host, port)
        }, delay)
    }

    public sendToTcpServer(data: string | Buffer): boolean {
        if (!this.tcpClient || this.tcpClient.readyState !== 'open') {
            this.log('TCP client not connected, cannot send data')
            return false
        }

        try {
            if (Buffer.isBuffer(data)) {
                this.tcpClient.write(new Uint8Array(data))
            } else {
                this.tcpClient.write(data)
            }
            this.log('Data sent to TCP server:', data.toString())
            return true
        } catch (error) {
            console.error('Error sending data to TCP server:', error)
            return false
        }
    }

    throttledTcpBroadcast(parsedData: any, receivedAt: number): void {
        const now = Date.now()

        if (now - this.lastRobotBroadcast >= this.robotThrottleMs) {
            this.notifyEventSubscribers('RobotData', {
                data: parsedData,
                receivedAt,
                type: 'robot'
            })
            this.lastRobotBroadcast = now
        }
    }




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

        this.log(`Client ${clientId} subscribed to ${eventName} with ID ${subscriptionId}`)

        this.sendToClient(clientId, 'SubscriptionConfirmed', {
            subscriptionId,
            eventName,
            timestamp: Date.now(),
            data,
        })

        return subscriptionId
    }

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

        this.log(`Client ${clientId} unsubscribed from ${subscription.eventName} (ID: ${subscriptionId})`)
        return true
    }



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
                    this.log(`Unhandled message type from client ${clientId}:`, message.type)
            }
        } catch (error) {
            console.error(`Error processing message from client ${clientId}:`, error)
        }
    }

    handleConnectionParams(clientId: string, params: any): void {
        this.log(`Connection parameters received from client ${clientId}:`, params)
    }
    notifyEventSubscribers(eventName: string, data: any): void {
        let notifiedCount = 0
        for (const [clientId, client] of Array.from(this.clients.entries())) {
            if (client.subscriptions.has(eventName)) {
                this.sendToClient(clientId, eventName, data)
                notifiedCount++
            }
        }
        if (notifiedCount > 0) {
            this.log(`Notified ${notifiedCount} subscribers of event '${eventName}'`)
        }
    }

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
        this.log(`Client disconnected: ${clientId}, Remaining clients: ${this.clients.size}`)
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
                this.log(`Message sent to client ${clientId}: ${type}`)
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
            this.log(`Broadcast ${type} sent to ${sentCount} clients`)
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
                            this.log(
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
                this.log(`Heartbeat check: ${activeClients} active, ${inactiveClients} inactive clients`)
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
        this.log('WebSocket server shut down')

        this.emit('serverShutdown')
    }
}

if (require.main === module) {
    const socketServer = new SocketServer()

    process.on('SIGINT', () => {
        console.log('[SERVER] Received SIGINT. Shutting down WebSocket server...')
        socketServer.shutdown()
        process.exit(0)
    })

    process.on('SIGTERM', () => {
        console.log('[SERVER] Received SIGTERM. Shutting down WebSocket server...')
        socketServer.shutdown()
        process.exit(0)
    })
}
