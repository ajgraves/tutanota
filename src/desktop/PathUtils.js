//@flow
import path from "path"
import url from "url"
import {isReservedFilename, sanitizeFilename} from "../api/common/utils/FileUtils"
import {neverNull} from "../api/common/utils/Utils"
import {promises as fs} from "fs"

/**
 * Can be used when you want to ensure only valid file extensions are being provided. feel free to add some
 */
export type ValidExtension = "msg"

/**
 * @param pathToConvert absolute Path to a file
 * @returns {string} file:// URL that can be extended with query parameters and loaded with BrowserWindow.loadURL()
 */
export function pathToFileURL(pathToConvert: string): string {
	pathToConvert = pathToConvert
		.trim()
		.split(path.sep)
		.map((fragment) => encodeURIComponent(fragment))
		.join("/")
	const extraSlashForWindows = process.platform === "win32" && pathToConvert !== ''
		? "/"
		: ""
	let urlFromPath = url.format({
		pathname: extraSlashForWindows + pathToConvert.trim(),
		protocol: 'file:'
	})

	return urlFromPath.trim()
}

/**
 * compares a filename to a list of filenames and finds the first number-suffixed
 * filename not already contained in the list.
 * @returns {string} the basename appended with '-<first non-clashing positive number>.<ext>
 */
export function nonClobberingFilename(files: Array<string>, filename: string): string {
	filename = sanitizeFilename(filename)
	const clashingFile = files.find(f => f === filename)
	if (typeof clashingFile !== "string") { // all is well
		return filename
	} else { // there are clashing file names
		const ext = path.extname(filename)
		const basename = path.basename(filename, ext)
		const clashNumbers: Array<number> = files
			.filter(f => f.startsWith(`${basename}-`))
			.map(f => f.slice(0, f.length - ext.length))
			.map(f => f.slice(basename.length + 1, f.length))
			.map(f => !f.startsWith('0') ? parseInt(f, 10) : 0)
			.filter(n => !isNaN(n) && n > 0)
		const clashNumbersSet: Set<number> = new Set(clashNumbers)
		clashNumbersSet.add(0)

		// if a number is bigger than its index, there is room somewhere before that number
		const firstGapMinusOne = Array
			.from(clashNumbersSet)
			.sort((a, b) => a - b)
			.find((n, i, a) => a[i + 1] > i + 1)

		return !isNaN(firstGapMinusOne)
			? `${basename}-${neverNull(firstGapMinusOne) + 1}${ext}`
			: `${basename}-${clashNumbersSet.size}${ext}`
	}
}

export function looksExecutable(file: string): boolean {
	// only windows will happily execute a just downloaded program
	if (process.platform === 'win32') {
		// taken from https://www.lifewire.com/list-of-executable-file-extensions-2626061
		const ext = path.extname(file).toLowerCase().slice(1)
		return [
			'exe', 'bat', 'bin', 'cmd', 'com', 'cpl', 'gadget',
			'inf', 'inx', 'ins', 'isu', 'job', 'jse', 'lnk', 'msc',
			'msi', 'msp', 'mst', 'paf', 'pif', 'ps1', 'reg', 'rgs',
			'scr', 'sct', 'shb', 'sct', 'shs', 'u3p', 'vb', 'vbe',
			'vbs', 'vbscript', 'ws', 'wsf', 'wsh'
		].includes(ext)
	}

	return false
}

/**
 * Determine if a file exists with a given path and it is a regular file
 * @param filePath
 * @returns Promise<boolean>
 */
export async function fileExists(filePath: string): Promise<boolean> {
	return fs.stat(filePath)
	         .then(stats => stats.isFile())
	         .catch(() => false)
}

