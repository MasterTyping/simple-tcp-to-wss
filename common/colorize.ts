import chalk from 'chalk'

/**
 * 콘솔 출력에 색상을 적용하는 유틸리티.
 *
 * 이 유틸리티는 콘솔 출력에 색상과 스타일을 쉽게 적용할 수 있는 
 * 함수들을 제공하여 가독성과 시각적 효과를 향상시킵니다.
 */
export const Colorize = {
    error: chalk.red.bold,
    success: chalk.green.bold,
    warning: chalk.yellow.bold,
    info: chalk.blue,
    debug: chalk.bgBlue.yellow.bold,
    tcp: chalk.cyan,
    client: chalk.magenta,
    server: chalk.green.bold,
    data: chalk.yellow,
}
