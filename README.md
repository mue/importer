# importer

## Environment

```
S3_ACCESS=
S3_SECRET=
SUPABASE_URL=
SUPABASE_SECRET=
```

## Usage

Copy the photos to upload to the `import` directory, then

```
node . -p <photographer name> -l <fallback location name>
```

> **Warning**
>
> The files in the import directory will be deleted

### Example

```
node . -p "Isaac Saunders" -l "England"
```

Image URLs look like:

```
https://cdn.muetab.com/img/fhd/6ab5de7b5b878d235193f15beaf615c8.webp
```