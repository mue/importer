import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import AWS from 'aws-sdk';

config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET);

const s3 = new AWS.S3({
	credentials: {
		accessKeyId: process.env.S3_ACCESS,
		secretAccessKey: process.env.S3_SECRET,
	},
	endpoint: process.env.S3_ENDPOINT,
	s3ForcePathStyle: true,
	signatureVersion: 'v4',
});

const id = '3d7940be783784f350adc7eac579fea1';
const keys = [
	`/img/hd/${id}.avif`,
	`/img/hd/${id}.webp`,
	`/img/fhd/${id}.avif`,
	`/img/fhd/${id}.webp`,
	`/img/qhd/${id}.avif`,
	`/img/qhd/${id}.webp`,
	`/img/original/${id}.avif`,
	`/img/original/${id}.webp`,
];

await supabase.from('images').delete().eq('id', id);

for (const Key of keys) {
	await s3.deleteObject(
		{
			Bucket: 'mue',
			Key,
		},
	).promise();
}