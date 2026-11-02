import { prepareDesktopConnection } from './desktopConnection.js'

if (await prepareDesktopConnection()) await import('./main.js')
