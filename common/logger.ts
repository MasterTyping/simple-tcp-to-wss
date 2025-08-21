import { Colorize } from "./colorize";


/**
 * 다양한 로그 레벨을 지원하는 Logger 유틸리티 클래스입니다.
 *
 * @example
 * ```typescript
 * const logger = new Logger(true);
 * logger.log('서버 시작');
 * logger.error('에러 발생');
 * logger.tcp('TCP 연결됨');
 * logger.client('클라이언트 접속');
 * logger.success('성공 메시지');
 * logger.warning('경고 메시지');
 * ```
 */
export class Logger {
    /**
     * Logger 인스턴스를 생성합니다.
     * @param debugMode true면 debug 로그가 출력됩니다.
     */
    constructor(private debugMode: boolean = true) { }

    /**
     * 일반 로그를 출력합니다.
     * @param args 로그로 출력할 값들
     * @example
     * logger.log('서버 시작');
     */
    log(...args: any[]): void {
        if (this.debugMode) {
            const timestamp = Colorize.debug(new Date().toISOString())
            const errorTag = Colorize.error('[ERROR]')
            const msg = Colorize.error(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
            console.log(timestamp, errorTag, msg);
        }
    }

    /**
     * 에러 로그를 출력합니다.
     * @param args 에러로 출력할 값들
     * @example
     * logger.error('에러 발생', error);
     */
    error(...args: any[]): void {
        const timestamp = Colorize.debug(new Date().toISOString())
        const errorTag = Colorize.error('[ERROR]')
        const msg = Colorize.error(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        console.error(timestamp, errorTag, msg);
    }

    /**
     * TCP 관련 로그를 출력합니다.
     * @param args TCP 로그로 출력할 값들
     * @example
     * logger.tcp('TCP 연결됨');
     */
    tcp(...args: any[]): void {
        if (this.debugMode) {
            const timestamp = Colorize.debug(new Date().toISOString())
            const tcpTag = Colorize.info('[TCP]')
            const msg = Colorize.info(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
            console.log(timestamp, tcpTag, msg);
        }
    }

    /**
     * 클라이언트 관련 로그를 출력합니다.
     * @param args 클라이언트 로그로 출력할 값들
     * @example
     * logger.client('클라이언트 접속', clientId);
     */
    client(...args: any[]): void {
        if (this.debugMode) {
            const timestamp = Colorize.debug(new Date().toISOString())
            const clientTag = Colorize.info('[CLIENT]')
            const msg = Colorize.info(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
            console.log(timestamp, clientTag, msg);
        }
    }

    /**
     * 성공 로그를 출력합니다.
     * @param args 성공 로그로 출력할 값들
     * @example
     * logger.success('성공 메시지');
     */
    success(...args: any[]): void {
        const timestamp = Colorize.debug(new Date().toISOString())
        const successTag = Colorize.info('[SUCCESS]')
        const msg = Colorize.info(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        console.log(timestamp, successTag, msg);
    }

    /**
     * 경고 로그를 출력합니다.
     * @param args 경고 로그로 출력할 값들
     * @example
     * logger.warning('경고 메시지');
     */
    warning(...args: any[]): void {
        const timestamp = Colorize.debug(new Date().toISOString())
        const warningTag = Colorize.info('[WARNING]')
        const msg = Colorize.info(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '))
        console.warn(timestamp, warningTag, msg);
    }
}
