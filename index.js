import { config } from 'dotenv';
import gradient from 'gradient-string';
import figlet from 'figlet';
import { program } from 'commander';
import { colours } from 'leeks.js';
import fs, { promises as fsp } from 'fs';
import inquirer from 'inquirer';
import ora from 'ora';
import fetch from 'node-fetch';
import csv from 'convert-csv-to-json';
import ProgressBar from 'progress';
import { resolve } from 'path';
import sharp from 'sharp';
import piexif from 'piexifjs';
import { createHash } from 'crypto';

config();

console.log(gradient('#ffb032', '#dd3b67').multiline(figlet.textSync('Mue Importer', {})));

program
	.option('-c, --category <name>', 'image category', 'outdoors')
	.option('-l, --location <name>', 'fallback location name (if not in EXIF)')
	.option('-p, --photographer <name>', 'photographer name');
program.parse(process.argv);
const options = program.opts();

console.log(colours.greenBright(`Category: ${options.category}`));

if (!options.location) console.log(colours.yellowBright('Warning: no fallback location'));
else console.log(colours.greenBright(`Fallback location: ${options.location}`));

if (!options.photographer) {
	console.log(colours.redBright('Error: no photographer'));
	process.exit(1);
} else {
	console.log(colours.greenBright(`Photographer: ${options.photographer}`));
}

const resolutions = {
	hd: [null, 720],
	fhd: [null, 1080], // eslint-disable-line sort-keys
	qhd: [null, 1440],
	original: null, // eslint-disable-line sort-keys
};
const formats = ['webp', 'avif'];

const variants = Object.entries(resolutions)
	.map(([k, v]) =>
		formats.map(format => ({
			format,
			name: k,
			resolution: v,
		})))
	.flat();

console.log(colours.blueBright(`Variants: ${variants.length}`));

const files = (await fsp.readdir('import', { withFileTypes: true }))
	.filter(file => !file.isDirectory() && !file.name.startsWith('.'))
	.map(file => file.name);

const { start } = await inquirer.prompt([{
	default: !!options.photographer,
	message: `Do you want to continue with ${files.length} files?`,
	name: 'start',
	type: 'confirm',
}]);

if (!start) {
	console.log(colours.redBright('Canceled.'));
	process.exit(1);
}

if (!fs.existsSync('android.json')) {
	const spinner1 = ora('Downloading supported_devices.csv').start();
	const res = await fetch('https://storage.googleapis.com/play_public/supported_devices.csv');
	const fileStream = fs.createWriteStream('supported_devices.csv');
	await new Promise((resolve, reject) => {
		res.body.pipe(fileStream);
		res.body.on('error', reject);
		fileStream.on('finish', resolve);
	});
	spinner1.succeed('Downloaded supported_devices.csv');
	const spinner2 = ora('Processing android.json').start();
	let json = csv.fieldDelimiter(',').ucs2Encoding().getJsonFromCsv('supported_devices.csv');
	await fsp.unlink('supported_devices.csv');
	json = json.reduce((json, data) => {
		json[data.Model] = data.MarketingName.startsWith(data.RetailBranding) ? data.MarketingName : data.RetailBranding + ' ' + (data.MarketingName || data.Model);
		return json;
	}, {});
	await fsp.writeFile('android.json', JSON.stringify(json), 'utf8');
	spinner2.succeed('Processed android.json');
}

const android = JSON.parse(await fsp.readFile('android.json'));

const bar = new ProgressBar(':bar :id (:file) :current/:total (:percent) - :elapsed/:eta, :rate/s', { total: files.length });

for (const file of files) {
	const buffer = await fsp.readFile(resolve('import', file));
	const binary = buffer.toString('binary');
	const exif = piexif.load(binary);
	const image = Buffer.from(piexif.remove(binary), 'binary'); // same as `buffer` but without metadata
	const checksum = createHash('md5').update(image).digest('hex'); // checksum of the **meta-stripped** file

	bar.tick({
		file,
		id: checksum,
	});

	const data = {
		camera: null,
		category: options.category?.toLowerCase(),
		createdAt: exif.Exif[piexif.ExifIFD.DateTimeOriginal],
		id: checksum,
		locationData: null,
		locationName: options.location,
		photographer: options.photographer,
	};

	if (exif['0th'][piexif.ImageIFD.Model] && android[data.camera]) data.camera = exif['0th'][piexif.ImageIFD.Model];
	else data.camera = exif['0th'][piexif.ImageIFD.Model];

	if (data.createdAt) {
		const regex = /(?<year>\d{4}):(?<month>\d{2}):(?<day>\d{2})\s(?<time>\d{2}:\d{2}:\d{2})/;
		const { groups } = regex.exec(data.createdAt);
		if (groups) data.createdAt = new Date(`${groups.year}-${groups.month}-${groups.day}T${groups.time}`);
	}

	const latitude = exif.GPS[piexif.GPSIFD.GPSLatitude];
	const latitudeRef = exif.GPS[piexif.GPSIFD.GPSLatitudeRef];
	const longitude = exif.GPS[piexif.GPSIFD.GPSLongitude];
	const longitudeRef = exif.GPS[piexif.GPSIFD.GPSLongitudeRef];

	if (latitude && longitude) {
		// convert & reduce precision
		const decimalLatitude = (latitudeRef === 'N' ? 1 : -1) * piexif.GPSHelper.dmsRationalToDeg(latitude).toFixed(1);
		const decimalLongitude = (longitudeRef === 'E' ? 1 : -1) * piexif.GPSHelper.dmsRationalToDeg(longitude).toFixed(1);
		data.locationData = `${decimalLatitude},${decimalLongitude}`;
		try {
			const res = await fetch(`https://proxy.muetab.com/weather/autolocation?lat=${decimalLatitude}&lon=${decimalLongitude}`);
			const json = await res.json();
			if (json[0]) data.locationName = `${json[0].name}, ${json[0].state}`;
		} catch {
			console.log(colours.redBright(`Failed to fetch location data for ${file}`));
		}
	}

	// for await (const variant of variants) {
	// 	let wip = sharp(image);
	// 	if (variant.resolution) wip = wip.resize(variant.resolution[0], variant.resolution[1]);
	// 	wip = wip.toFormat(variant.format, {
	// 		effort: 6,
	// 		quality: 85,
	// 	});
	// 	wip = wip.toBuffer();
	// 	// TODO: upload
	// }

	// TODO: after successful uploads, save to database

	// TODO: unlink file
}