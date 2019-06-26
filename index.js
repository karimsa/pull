#!/usr/bin/env node

/**
 * @file index.js
 * @copyright 2019-present Karim Alibhai. All rights reserved.
 */

const os = require('os')
const fs = require('fs')
const path = require('path')
const request = require('request-promise-native')
const requestRaw = require('request')
const ansi = require('ansi-escapes')
const prettyTime = require('pretty-time')
const argv = require('minimist')(process.argv.slice(2))

let spinnerLoc = -1
let spinnerRender
const spinnerChars = '⠄⠆⠇⠋⠙⠸⠰⠠⠰⠸⠙⠋⠇⠆'
const checkmark = '\u001b[32m✓\u001b[39m'
const labels = []
const progress = []

function resetSpinners() {
	progress.forEach(() => {
		process.stdout.write(ansi.cursorUp(1) + '\r' + ansi.eraseLine + '\r')
	})
}

function renderSpinners() {
	if (++spinnerLoc === spinnerChars.length) {
		spinnerLoc = 0
	}

	// go up N lines
	process.stdout.write(ansi.cursorUp(progress.length))

	// render top down
	progress.forEach((p, i) => {
		// write spinner
		const progress = Math.round(p * 100)
		process.stdout.write(
			`\r${progress === 100 ? checkmark : spinnerChars[spinnerLoc]} ${
				labels[i]
			} ${progress}% ${ansi.eraseEndLine}\n`,
		)
	})

	spinnerRender = setTimeout(renderSpinners, 100)
}

function startSpinners() {
	progress.forEach(() => console.log())
	renderSpinners()
}

function stopSpinners() {
	clearTimeout(spinnerRender)
	resetSpinners()
}

function prettyBytes(bytes) {
	if (bytes >= 1024 ** 3) {
		return Math.round(100 * (bytes / 1024 ** 3)) / 100 + 'gb'
	}
	if (bytes >= 1024 ** 2) {
		return Math.round(100 * (bytes / 1024 ** 2)) / 100 + 'mb'
	}
	if (bytes >= 1024 ** 1) {
		return Math.round(100 * (bytes / 1024 ** 1)) / 100 + 'kb'
	}
	return bytes + 'b'
}

function downloadChunk(part, url, output, start, end, { headers }) {
	const outputStream = fs.createWriteStream(output)
	const inputStream = requestRaw({
		method: 'GET',
		url,
		headers: {
			...headers,
			Range: `bytes=${start}-${end - 1}`,
		},
		followAllRedirects: true,
	})
	const size = end - start
	let downloaded = 0

	return new Promise((resolve, reject) => {
		inputStream.on('response', res => {
			if (!res.headers['content-range']) {
				console.log(res.headers)
				reject(
					new Error(
						`Remote service does not support range downloads - please use curl`,
					),
				)
			}

			const contentLength = Number(res.headers['content-length'])
			if (contentLength > size) {
				reject(
					new Error(
						`Server responded with intent to stream ${prettyBytes(
							contentLength,
						)} - but client only expected ${prettyBytes(
							size,
						)} (${contentLength} > ${size})`,
					),
				)
			}
		})
		inputStream.on('data', chunk => {
			outputStream.write(chunk)
			downloaded += chunk.length
			if (downloaded > size) {
				reject(
					new Error(`Download size of chunk ${part} exceeded expected size`),
				)
			}
			progress[part] = downloaded / size
		})
		inputStream.on('end', () => {
			outputStream.close()
			resolve()
		})
		inputStream.on('error', err => reject(err))
	})
}

async function main({ url, output, concurrency, silent, headers }) {
	const timer = prettyTime.start()

	const headerMap = { 'User-Agent': '@karimsa/pull' }
	headers.map(header => {
		const key = header.substr(0, header.indexOf(':'))
		const value = header.substr(header.indexOf(':') + 1)

		headerMap[key] = value
	})

	const head = await request({
		method: 'HEAD',
		url,
		headers: headerMap,
		resolveWithFullResponse: true,
		followAllRedirects: true,
	})
	const contentLength = parseInt(head.headers['content-length'], 10)

	if (isNaN(contentLength) || contentLength === 0) {
		throw new Error(`Cannot download file with invalid length`)
	}
	if (head.headers['accept-ranges'] !== 'bytes') {
		throw new Error(
			`Remote service does not support range downloads - please use curl`,
		)
	}

	const chunkSize = Math.floor(contentLength / concurrency)
	const goals = []

	for (let i = 0; i < concurrency; i++) {
		const start = chunkSize * i
		const end = i === concurrency - 1 ? contentLength : chunkSize * (i + 1)

		labels.push(`Downloading: ${prettyBytes(start)} to ${prettyBytes(end)}`)
		progress.push(0)
		goals.push(
			downloadChunk(
				i,
				url,
				path.resolve(process.cwd(), output + '.p' + i),
				start,
				end,
				{
					headers: headerMap,
				},
			),
		)
	}

	if (!silent) startSpinners()
	await Promise.all(goals)
	if (!silent) stopSpinners()

	// merge files
	process.stdout.write(`Merging files ...`)
	const finalOutput = fs.createWriteStream(path.resolve(process.cwd(), output))
	for (let i = 0; i < concurrency; ++i) {
		await new Promise((resolve, reject) => {
			process.stdout.write(`\rWriting: p${i} -> output`)
			const filename = path.resolve(process.cwd(), output + '.p' + i)
			const input = fs.createReadStream(filename)
			input.on('data', chunk => finalOutput.write(chunk))
			input.on('close', () => {
				fs.unlink(filename, err => {
					if (err) reject(err)
					else resolve()
				})
			})
			input.on('error', err => reject(err))
		})
	}
	finalOutput.close()

	console.log(`\rDownloaded ${output} in ${timer.end()}${ansi.eraseEndLine}`)
}

if (argv._.length !== 1 || argv.help || argv.h) {
	console.error(`usage: npx @karimsa/pull [options] <url>`)
	console.error(
		`\t-c, --concurrency [number]\tnumber of chunks to download file in`,
	)
	console.error(`\t-o, --output [file]\t\tset the output file`)
	console.error(`\t-s, --silent\t\t\tdisable progress spinners`)
	console.error(`\t-H, --header [key: value]\tset a request header`)
	process.exit(1)
}

const dlUrl = argv._[0]
const output = argv.output || argv.o || path.basename(new URL(dlUrl).pathname)
const concurrency = Number(argv.concurrency || argv.c || 2 * os.cpus().length)
const silent = !!(argv.silent || argv.s)
const headers =
	argv.header || argv.H
		? Array.isArray(argv.header || argv.H)
			? argv.header || argv.H
			: [argv.header || argv.H]
		: []

main({ url: dlUrl, output, concurrency, silent, headers }).catch(err => {
	console.error(err)
	if (err.status) {
	}
	console.error(err.stack)
	process.exit(1)
})
