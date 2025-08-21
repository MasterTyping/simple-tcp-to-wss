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
 * @description Represents a connected WebSocket client.
 */
interface SocketClient {
    id: string
    socket: WebSocket
    lastActivity: number
    subscriptions: Map<string, Set<string>>
}

interface Subscription {
    clientId: string
    subscriptionId: string
    eventName: string
}

const env = process.env.NODE_ENV || 'development'

dotenv.config({
    path: env === 'development' ? '.env.development' : '.env.production'
})

export class SocketServer extends EventEmitter {
    private wss: WebSocketServer
    private clients: Map<string, SocketClient> = new Map()
    private subscriptions: Map<string, Subscription> = new Map()
    private pingInterval: NodeJS.Timeout | null = null
    private debugMode: boolean = true
    private nextSubscriptionId: number = 1
    private tcpClient: net.Socket | null = null
    private tcpReconnectInterval: NodeJS.Timeout | null = null
    private tcpReconnectAttempts: number = 0
    private maxTcpReconnectAttempts: number = 5
    private pingPongInterval: NodeJS.Timeout | null = null

    private intervals: Map<string, NodeJS.Timeout> = new Map()

    private robotThrottleMs: number = 16
    private mobileThrottleMs: number = 16
    private criThrottleMs: number = 100
    private lastCriBroadcast: number = 0
    private lastRobotBroadcast: number = 0
    private lastMobileBroadcast: number = 0
    private latestTcpData: any = null
    private tcpBroadcastTimer: NodeJS.Timeout | null = null

    private log(...args: any[]): void {
        if (this.debugMode) {
            const timestamp = colorize.debug(new Date().toISOString())
            const serverTag = colorize.server('[SERVER]')
            const msg = colorize.info(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
            console.log(`${serverTag} ${timestamp}`, msg)
        }
    }

    private logError(...args: any[]): void {
        const timestamp = colorize.debug(new Date().toISOString())
        const errorTag = colorize.error('[ERROR]')
        const msg = colorize.error(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        console.error(`${errorTag} ${timestamp}`, msg)
    }

    private logTcp(...args: any[]): void {
        if (this.debugMode) {
            const timestamp = colorize.debug(new Date().toISOString())
            const tcpTag = colorize.tcp('[TCP]')
            const msg = colorize.tcp(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
            console.log(`${tcpTag} ${timestamp}`, msg)
        }
    }

    private logClient(...args: any[]): void {
        if (this.debugMode) {
            const timestamp = colorize.debug(new Date().toISOString())
            const clientTag = colorize.client('[CLIENT]')
            const msg = colorize.client(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
            console.log(`${clientTag} ${timestamp}`, msg)
        }
    }

    private logSuccess(...args: any[]): void {
        const timestamp = colorize.debug(new Date().toISOString())
        const successTag = colorize.success('[SUCCESS]')
        const msg = colorize.success(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        console.log(`${successTag} ${timestamp}`, msg)
    }

    private logWarning(...args: any[]): void {
        const timestamp = colorize.debug(new Date().toISOString())
        const warningTag = colorize.warning('[WARNING]')
        const msg = colorize.warning(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        console.log(`${warningTag} ${timestamp}`, msg)
    }

    private setupDefaultEvents(): void {
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

    private setupSocketEvents(): void {
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

    private setupTcpClient(host: string, port: number): void {
        this.connectToTcpServer(host, port)
    }

    private connectToTcpServer(host: string, port: number): void {
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

    private scheduleTcpReconnect(host: string, port: number): void {
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

    private throttledTcpBroadcast(parsedData: any, receivedAt: number): void {
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




    private handleSubscription(clientId: string, eventName: string, data?: any): string {
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

    private handleUnsubscription(clientId: string, subscriptionId: string): boolean {
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



    private handleClientMessage(clientId: string, data: any): void {
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

    private handleConnectionParams(clientId: string, params: any): void {
        this.log(`Connection parameters received from client ${clientId}:`, params)
    }
    private notifyEventSubscribers(eventName: string, data: any): void {
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

    private handleClientDisconnect(clientId: string): void {
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

    private sendToClient(clientId: string, type: string, data: any): void {
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

    private broadcast(type: string, data: any, excludeClientIds: string[] = []): void {
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

    private generateClientId(): string {
        return `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    }

    private startHeartbeat(): void {
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
