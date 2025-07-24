// reads a nifti file and saves a chosen slice to a png image file
import * as nifti from "nifti-reader-js";
import { PNG } from "pngjs";
import { readFileSync, writeFileSync } from "fs";
import { gunzipSync } from "zlib";
import { Command } from "commander";
interface Nii2PngOptions {
  inputFile: string;
  output: string;
  dim: string; // x, y, z (1, 2, 3)
  slice: number;
}

function normalizeToUint8(
  data: Float32Array | Float64Array | Int16Array | Uint8Array,
  min: number,
  max: number
): Uint8Array {
  const normalized = new Uint8Array(data.length);
  const range = max - min || 1; // Prevent division by zero

  for (let i = 0; i < data.length; i++) {
    normalized[i] = Math.round(((data[i]! - min) / range) * 255);
  }

  return normalized;
}

export const nii2png = (options: Nii2PngOptions) => {
  // Read the NIFTI file
  let fileData = readFileSync(options.inputFile!);

  // Check if the file is gzipped
  if (options.inputFile.endsWith(".gz")) {
    fileData = Buffer.from(gunzipSync(fileData));
  }

  // Parse NIFTI
  const arrayBuffer = fileData.buffer.slice(
    fileData.byteOffset,
    fileData.byteOffset + fileData.byteLength
  );

  if (!nifti.isCompressed(arrayBuffer) && !nifti.isNIFTI(arrayBuffer)) {
    throw new Error("Not a valid NIFTI file");
  }

  const header = nifti.readHeader(arrayBuffer);
  if (!header) {
    throw new Error("Failed to read NIFTI header");
  }

  const imageData = nifti.readImage(header, arrayBuffer);
  if (!imageData) {
    throw new Error("Failed to read NIFTI image data");
  }

  // Get dimensions
  const dims = header.dims;
  const nx = dims[1] || 0;
  const ny = dims[2] || 0;
  const nz = dims[3] || 0;

  // Validate slice number
  const dimIndex =
    parseInt(options.dim) ||
    ["x", "y", "z"].indexOf(options.dim.toLowerCase()) + 1;
  const maxSlice = dims[dimIndex] || 0;

  if (options.slice < 0 || options.slice >= maxSlice) {
    throw new Error(
      `Slice ${options.slice} out of range. Valid range: 0-${maxSlice - 1}`
    );
  }

  // Determine slice dimensions and data extraction
  let width: number, height: number;
  let sliceData: number[];

  // Create typed array based on data type
  let typedArray: Float32Array | Float64Array | Int16Array | Uint8Array;

  switch (header.datatypeCode) {
    case nifti.NIFTI1.TYPE_UINT8:
      typedArray = new Uint8Array(imageData);
      break;
    case nifti.NIFTI1.TYPE_INT16:
      typedArray = new Int16Array(imageData);
      break;
    case nifti.NIFTI1.TYPE_FLOAT32:
      typedArray = new Float32Array(imageData);
      break;
    case nifti.NIFTI1.TYPE_FLOAT64:
      typedArray = new Float64Array(imageData);
      break;
    case nifti.NIFTI1.TYPE_RGB24:
      // RGB24 stores 3 bytes per voxel (R,G,B), we'll convert to grayscale
      typedArray = new Uint8Array(imageData);
      break;
    default:
      throw new Error(`Unsupported data type: ${header.datatypeCode}`);
  }

  // Handle RGB24 format differently
  const isRGB = header.datatypeCode === nifti.NIFTI1.TYPE_RGB24;
  const pixelStride = isRGB ? 3 : 1; // RGB has 3 bytes per pixel

  // For RGB, store all color channels; for grayscale, store single values
  sliceData = [];
  let rgbData: number[] = [];

  switch (dimIndex) {
    case 1: // X (sagittal)
      width = ny;
      height = nz;
      for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
          const index = (options.slice + j * nx + k * nx * ny) * pixelStride;
          if (isRGB) {
            rgbData.push(typedArray[index] || 0); // R
            rgbData.push(typedArray[index + 1] || 0); // G
            rgbData.push(typedArray[index + 2] || 0); // B
          } else {
            sliceData.push(typedArray[index] || 0);
          }
        }
      }
      break;
    case 2: // Y (coronal)
      width = nx;
      height = nz;
      for (let k = 0; k < nz; k++) {
        for (let i = 0; i < nx; i++) {
          const index = (i + options.slice * nx + k * nx * ny) * pixelStride;
          if (isRGB) {
            rgbData.push(typedArray[index] || 0); // R
            rgbData.push(typedArray[index + 1] || 0); // G
            rgbData.push(typedArray[index + 2] || 0); // B
          } else {
            sliceData.push(typedArray[index] || 0);
          }
        }
      }
      break;
    case 3: // Z (axial)
      width = nx;
      height = ny;
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const index = (i + j * nx + options.slice * nx * ny) * pixelStride;
          if (isRGB) {
            rgbData.push(typedArray[index] || 0); // R
            rgbData.push(typedArray[index + 1] || 0); // G
            rgbData.push(typedArray[index + 2] || 0); // B
          } else {
            sliceData.push(typedArray[index] || 0);
          }
        }
      }
      break;
    default:
      throw new Error("Invalid dimension. Use 1 (x), 2 (y), or 3 (z)");
  }

  // Create PNG
  const png = new PNG({ width, height });

  if (isRGB) {
    // For RGB data, write color values directly
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = (y * width + x) * 3;
        const dstIdx = ((height - 1 - y) * width + x) << 2;

        png.data[dstIdx] = rgbData[srcIdx] || 0; // R
        png.data[dstIdx + 1] = rgbData[srcIdx + 1] || 0; // G
        png.data[dstIdx + 2] = rgbData[srcIdx + 2] || 0; // B
        png.data[dstIdx + 3] = 255; // A
      }
    }
  } else {
    // For grayscale data, normalize and write
    const min = Math.min(...sliceData);
    const max = Math.max(...sliceData);
    const normalizedData = normalizeToUint8(
      new Float32Array(sliceData),
      min,
      max
    );

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = y * width + x;
        const dstIdx = ((height - 1 - y) * width + x) << 2;
        const value = normalizedData[srcIdx];

        png.data[dstIdx] = value || 0; // R
        png.data[dstIdx + 1] = value || 0; // G
        png.data[dstIdx + 2] = value || 0; // B
        png.data[dstIdx + 3] = 255; // A
      }
    }
  }

  // Write PNG file
  const buffer = PNG.sync.write(png);
  writeFileSync(options.output, buffer);

  console.log(
    `Saved ${options.dim} slice ${options.slice} to ${options.output}`
  );
};

export const nii2pngCLI = () => {
  return new Command("nii2png")
    .description("Convert NIFTI slice to PNG image")
    .requiredOption("-i, --input <file>", "Input NIFTI file path")
    .requiredOption("-o, --output <file>", "Output PNG file path")
    .option(
      "-d, --dim <dimension>",
      "Dimension to slice along: x (sagittal), y (coronal), z (axial)",
      "z"
    )
    .option("-s, --slice <number>", "Slice number", "0")
    .action((options) => {
      try {
        nii2png({
          inputFile: options.input,
          output: options.output,
          dim: options.dim,
          slice: parseInt(options.slice),
        });
      } catch (error) {
        console.error(
          "Error:",
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    });
};
