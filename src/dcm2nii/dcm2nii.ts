// converts DICOM files to NIFTI format using dcmjs and nifti-reader-js
// @ts-ignore
import * as dcmjs from "dcmjs";
import * as nifti from "nifti-reader-js";
import { readFileSync, writeFileSync, statSync, readdirSync } from "fs";
import { join, extname, basename, dirname } from "path";
import { Command } from "commander";

interface Dcm2NiiOptions {
  input: string; // Can be single file, enhanced file, or directory
  output?: string; // Output directory or file path
}

interface DicomSeries {
  seriesInstanceUID: string;
  files: string[];
  seriesDescription?: string;
  seriesNumber?: number;
}

function isDicomFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".dcm" || ext === ".dicom" || ext === "";
}

function getDicomFilesFromDirectory(dirPath: string): string[] {
  const files = readdirSync(dirPath);
  return files
    .map((file) => join(dirPath, file))
    .filter((filePath) => {
      try {
        const stats = statSync(filePath);
        return stats.isFile() && isDicomFile(filePath);
      } catch {
        return false;
      }
    })
    .sort();
}

function groupDicomFilesBySeries(dicomFiles: string[]): DicomSeries[] {
  const seriesMap = new Map<string, DicomSeries>();

  for (const filePath of dicomFiles) {
    try {
      const buffer = readFileSync(filePath);
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      );

      const parsedData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
      const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
        parsedData.dict
      );

      const seriesInstanceUID = dataset.SeriesInstanceUID as string;
      if (!seriesInstanceUID) {
        console.warn(`No SeriesInstanceUID found in ${filePath}, skipping`);
        continue;
      }

      if (!seriesMap.has(seriesInstanceUID)) {
        seriesMap.set(seriesInstanceUID, {
          seriesInstanceUID,
          files: [],
          seriesDescription: dataset.SeriesDescription as string,
          seriesNumber: dataset.SeriesNumber as number,
        });
      }

      seriesMap.get(seriesInstanceUID)!.files.push(filePath);
    } catch (error) {
      console.warn(`Failed to read DICOM metadata from ${filePath}: ${error}`);
    }
  }

  // Sort files within each series by instance number or filename
  for (const series of seriesMap.values()) {
    series.files.sort((a, b) => {
      try {
        const bufferA = readFileSync(a);
        const bufferB = readFileSync(b);

        const arrayBufferA = bufferA.buffer.slice(
          bufferA.byteOffset,
          bufferA.byteOffset + bufferA.byteLength
        );
        const arrayBufferB = bufferB.buffer.slice(
          bufferB.byteOffset,
          bufferB.byteOffset + bufferB.byteLength
        );

        const datasetA = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
          dcmjs.data.DicomMessage.readFile(arrayBufferA).dict
        );
        const datasetB = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
          dcmjs.data.DicomMessage.readFile(arrayBufferB).dict
        );

        const instanceA = (datasetA.InstanceNumber as number) || 0;
        const instanceB = (datasetB.InstanceNumber as number) || 0;

        return instanceA - instanceB;
      } catch {
        // Fallback to filename sorting
        return basename(a).localeCompare(basename(b));
      }
    });
  }

  return Array.from(seriesMap.values());
}



function createNiftiFromMultiframe(multiframe: any): Buffer {
  // Extract image dimensions and data from the multiframe dataset
  const pixelData = multiframe.PixelData;
  const rows = multiframe.Rows as number;
  const columns = multiframe.Columns as number;
  const numberOfFrames = (multiframe.NumberOfFrames as number) || 1;
  
  // Check if this is a 4D dataset
  const numberOfSlices = (multiframe.NumberOfSlices as number) || numberOfFrames;
  const numberOfTimepoints = (multiframe.NumberOfTemporalPositions as number) || 1;
  
  let dims: number[];
  let is4D = false;
  
  if (numberOfTimepoints > 1) {
    // 4D dataset: X, Y, Z, T
    is4D = true;
    dims = [4, columns, rows, numberOfSlices, numberOfTimepoints, 1, 1, 1];
    console.log(`NIFTI conversion: ${columns}x${rows}x${numberOfSlices}x${numberOfTimepoints} (4D)`);
  } else {
    // 3D dataset: X, Y, Z
    dims = [3, columns, rows, numberOfFrames, 1, 1, 1, 1];
    console.log(`NIFTI conversion: ${columns}x${rows}x${numberOfFrames} (3D)`);
  }

  // Get pixel spacing and slice thickness for proper scaling
  const pixelSpacing = (multiframe.PixelSpacing as number[]) || [1, 1];
  const sliceThickness = (multiframe.SliceThickness as number) || 1;

  // Create NIFTI header structure
  const header = {
    littleEndian: true,
    dim: dims,
    pixdim: [
      1,
      pixelSpacing[0] || 1,
      pixelSpacing[1] || 1,
      sliceThickness,
      is4D ? 1 : 1, // Time spacing (TR for 4D)
      1,
      1,
      1,
    ],
    datatype: nifti.NIFTI1.TYPE_INT16, // Assume 16-bit integer data
    bitpix: 16,
    cal_max: 0,
    cal_min: 0,
    scl_slope: 1,
    scl_inter: 0,
    regular: "r",
    dim_info: 0,
    intent_p1: 0,
    intent_p2: 0,
    intent_p3: 0,
    intent_code: 0,
    slice_start: 0,
    slice_end: (is4D ? numberOfSlices : numberOfFrames) - 1,
    slice_code: 0,
    xyzt_units: 2, // mm and seconds
    magic: "n+1\0",
    vox_offset: 352,
    descrip: "Created by egami dcm2nii",
    aux_file: "",
    qform_code: 1,
    sform_code: 1,
    quatern_b: 0,
    quatern_c: 0,
    quatern_d: 0,
    qoffset_x: 0,
    qoffset_y: 0,
    qoffset_z: 0,
    srow_x: [pixelSpacing[0] || 1, 0, 0, 0],
    srow_y: [0, pixelSpacing[1] || 1, 0, 0],
    srow_z: [0, 0, sliceThickness, 0],
    dims: is4D ? [columns, rows, numberOfSlices, numberOfTimepoints] : [columns, rows, numberOfFrames],
  };

  // Convert pixel data to appropriate format
  let imageData: ArrayBuffer;

  if (pixelData instanceof ArrayBuffer) {
    imageData = pixelData;
  } else if (
    pixelData instanceof Uint8Array ||
    pixelData instanceof Uint16Array ||
    pixelData instanceof Int16Array
  ) {
    imageData = pixelData.buffer.slice(
      pixelData.byteOffset,
      pixelData.byteOffset + pixelData.byteLength
    ) as ArrayBuffer;
  } else if (Array.isArray(pixelData)) {
    // Handle array of pixel data (likely from dcmjs parsing)
    const firstElement = pixelData[0];

    if (firstElement instanceof ArrayBuffer) {
      imageData = firstElement;
    } else if (
      firstElement instanceof Uint8Array ||
      firstElement instanceof Uint16Array ||
      firstElement instanceof Int16Array
    ) {
      imageData = firstElement.buffer.slice(
        firstElement.byteOffset,
        firstElement.byteOffset + firstElement.byteLength
      ) as ArrayBuffer;
    } else {
      // Fallback: convert array to Int16Array
      const int16Data = new Int16Array(pixelData);
      imageData = int16Data.buffer;
    }
  } else if (pixelData && typeof pixelData === "object") {
    // Handle dcmjs parsed pixel data structure
    // For enhanced DICOM, the pixel data might be stored as a single buffer containing all frames
    const firstFrame = pixelData[0] || pixelData["0"];

    if (firstFrame && firstFrame.constructor?.name === "ArrayBuffer") {
      imageData = firstFrame as ArrayBuffer;
    } else if (
      firstFrame instanceof Uint8Array ||
      firstFrame instanceof Uint16Array ||
      firstFrame instanceof Int16Array
    ) {
      imageData = firstFrame.buffer.slice(
        firstFrame.byteOffset,
        firstFrame.byteOffset + firstFrame.byteLength
      ) as ArrayBuffer;
    } else {
      throw new Error("Unsupported pixel data format in parsed structure");
    }
  } else {
    throw new Error("Unsupported pixel data format");
  }

  // Create NIFTI file buffer
  const headerSize = 352;
  const imageSize = imageData.byteLength;
  const totalSize = headerSize + imageSize;

  const niftiBuffer = Buffer.alloc(totalSize);

  // Write NIFTI header
  writeNiftiHeader(niftiBuffer, header);

  // Write image data
  const imageBuffer = Buffer.from(imageData);
  imageBuffer.copy(niftiBuffer, headerSize);

  return niftiBuffer;
}

function writeNiftiHeader(buffer: Buffer, header: any): void {
  // Write NIFTI-1 header (simplified version)
  let offset = 0;

  // sizeof_hdr
  buffer.writeInt32LE(348, offset);
  offset += 4;

  // data_type (unused)
  buffer.fill(0, offset, offset + 10);
  offset += 10;

  // db_name (unused)
  buffer.fill(0, offset, offset + 18);
  offset += 18;

  // extents
  buffer.writeInt32LE(16384, offset);
  offset += 4;

  // session_error
  buffer.writeInt16LE(0, offset);
  offset += 2;

  // regular
  buffer.writeUInt8(header.regular.charCodeAt(0), offset);
  offset += 1;

  // dim_info
  buffer.writeUInt8(header.dim_info, offset);
  offset += 1;

  // dim[8]
  for (let i = 0; i < 8; i++) {
    buffer.writeInt16LE(header.dim[i] || 0, offset);
    offset += 2;
  }

  // intent_p1, intent_p2, intent_p3
  buffer.writeFloatLE(header.intent_p1, offset);
  offset += 4;
  buffer.writeFloatLE(header.intent_p2, offset);
  offset += 4;
  buffer.writeFloatLE(header.intent_p3, offset);
  offset += 4;

  // intent_code
  buffer.writeInt16LE(header.intent_code, offset);
  offset += 2;

  // datatype
  buffer.writeInt16LE(header.datatype, offset);
  offset += 2;

  // bitpix
  buffer.writeInt16LE(header.bitpix, offset);
  offset += 2;

  // slice_start
  buffer.writeInt16LE(header.slice_start, offset);
  offset += 2;

  // pixdim[8]
  for (let i = 0; i < 8; i++) {
    buffer.writeFloatLE(header.pixdim[i] || 0, offset);
    offset += 4;
  }

  // vox_offset
  buffer.writeFloatLE(header.vox_offset, offset);
  offset += 4;

  // scl_slope, scl_inter
  buffer.writeFloatLE(header.scl_slope, offset);
  offset += 4;
  buffer.writeFloatLE(header.scl_inter, offset);
  offset += 4;

  // slice_end
  buffer.writeInt16LE(header.slice_end, offset);
  offset += 2;

  // slice_code
  buffer.writeUInt8(header.slice_code, offset);
  offset += 1;

  // xyzt_units
  buffer.writeUInt8(header.xyzt_units, offset);
  offset += 1;

  // cal_max, cal_min
  buffer.writeFloatLE(header.cal_max, offset);
  offset += 4;
  buffer.writeFloatLE(header.cal_min, offset);
  offset += 4;

  // slice_duration
  buffer.writeFloatLE(0, offset);
  offset += 4;

  // toffset
  buffer.writeFloatLE(0, offset);
  offset += 4;

  // glmax, glmin (unused)
  buffer.writeInt32LE(0, offset);
  offset += 4;
  buffer.writeInt32LE(0, offset);
  offset += 4;

  // descrip
  const descrip = header.descrip.substring(0, 79);
  buffer.write(descrip, offset, "ascii");
  offset += 80;

  // aux_file
  buffer.fill(0, offset, offset + 24);
  offset += 24;

  // qform_code, sform_code
  buffer.writeInt16LE(header.qform_code, offset);
  offset += 2;
  buffer.writeInt16LE(header.sform_code, offset);
  offset += 2;

  // quatern_b, quatern_c, quatern_d
  buffer.writeFloatLE(header.quatern_b, offset);
  offset += 4;
  buffer.writeFloatLE(header.quatern_c, offset);
  offset += 4;
  buffer.writeFloatLE(header.quatern_d, offset);
  offset += 4;

  // qoffset_x, qoffset_y, qoffset_z
  buffer.writeFloatLE(header.qoffset_x, offset);
  offset += 4;
  buffer.writeFloatLE(header.qoffset_y, offset);
  offset += 4;
  buffer.writeFloatLE(header.qoffset_z, offset);
  offset += 4;

  // srow_x, srow_y, srow_z
  for (let i = 0; i < 4; i++) {
    buffer.writeFloatLE(header.srow_x[i], offset);
    offset += 4;
  }
  for (let i = 0; i < 4; i++) {
    buffer.writeFloatLE(header.srow_y[i], offset);
    offset += 4;
  }
  for (let i = 0; i < 4; i++) {
    buffer.writeFloatLE(header.srow_z[i], offset);
    offset += 4;
  }

  // intent_name
  buffer.fill(0, offset, offset + 16);
  offset += 16;

  // magic
  buffer.write(header.magic, offset, "ascii");
  offset += 4;
}

function createMultiframeFromDatasets(datasets: any[]): any {
  if (datasets.length === 0) {
    throw new Error("No datasets provided");
  }

  // Use the first dataset as the template
  const firstDataset = datasets[0];
  
  // Check if we have enhanced DICOM files (multiple frames per file)
  const framesPerFile = firstDataset.NumberOfFrames as number || 1;
  const numFiles = datasets.length;
  
  
  if (framesPerFile > 1) {
    // This is a 4D dataset (e.g., DWI time series)
    // Each file contains multiple slices for one timepoint
    const totalTimepoints = numFiles;
    const slicesPerTimepoint = framesPerFile;
    
    // Collect all pixel data arrays, preserving the 4D structure
    const all4DPixelData: any[] = [];
    
    for (const dataset of datasets) {
      if (dataset.PixelData) {
        all4DPixelData.push(dataset.PixelData);
      }
    }

    // Create a 4D multiframe dataset
    const multiframe = {
      ...firstDataset,
      NumberOfFrames: totalTimepoints * slicesPerTimepoint, // Total frames in 4D volume
      NumberOfTemporalPositions: totalTimepoints,
      NumberOfSlices: slicesPerTimepoint,
      PixelData: concatenate4DPixelData(all4DPixelData, firstDataset, slicesPerTimepoint),
    };

    return multiframe;
  } else {
    // Standard 3D dataset - each file is one slice
    const pixelDataArrays: any[] = [];

    for (const dataset of datasets) {
      if (dataset.PixelData) {
        pixelDataArrays.push(dataset.PixelData);
      }
    }

    // Create a pseudo-multiframe dataset
    const multiframe = {
      ...firstDataset,
      NumberOfFrames: datasets.length,
      PixelData: concatenatePixelData(pixelDataArrays, firstDataset),
    };

    return multiframe;
  }
}

function concatenatePixelData(
  pixelDataArrays: any[],
  referenceDataset: any
): ArrayBuffer {
  if (pixelDataArrays.length === 0) {
    throw new Error("No pixel data found");
  }

  // Determine the data type and size from the reference dataset
  const bitsAllocated = (referenceDataset.BitsAllocated as number) || 16;
  const rows = referenceDataset.Rows as number;
  const columns = referenceDataset.Columns as number;
  const samplesPerPixel = (referenceDataset.SamplesPerPixel as number) || 1;

  const bytesPerPixel = Math.ceil(bitsAllocated / 8);
  const pixelsPerFrame = rows * columns * samplesPerPixel;
  const bytesPerFrame = pixelsPerFrame * bytesPerPixel;

  // Create a combined buffer
  const totalBytes = bytesPerFrame * pixelDataArrays.length;
  const combinedBuffer = new ArrayBuffer(totalBytes);
  const combinedView = new Uint8Array(combinedBuffer);

  let offset = 0;
  for (const pixelData of pixelDataArrays) {
    let frameData: Uint8Array;

    if (pixelData instanceof ArrayBuffer) {
      frameData = new Uint8Array(pixelData);
    } else if (
      pixelData instanceof Uint8Array ||
      pixelData instanceof Uint16Array ||
      pixelData instanceof Int16Array
    ) {
      frameData = new Uint8Array(
        pixelData.buffer,
        pixelData.byteOffset,
        pixelData.byteLength
      );
    } else if (Array.isArray(pixelData)) {
      // Convert array to appropriate typed array
      if (bitsAllocated <= 8) {
        const uint8Data = new Uint8Array(pixelData);
        frameData = new Uint8Array(uint8Data.buffer);
      } else {
        const uint16Data = new Uint16Array(pixelData);
        frameData = new Uint8Array(uint16Data.buffer);
      }
    } else {
      console.warn("Unsupported pixel data format, skipping frame");
      continue;
    }

    // Copy frame data to combined buffer
    const frameBytesToCopy = Math.min(frameData.length, bytesPerFrame);
    combinedView.set(frameData.subarray(0, frameBytesToCopy), offset);
    offset += bytesPerFrame;
  }

  return combinedBuffer;
}

function concatenate4DPixelData(
  pixelDataArrays: any[],
  referenceDataset: any,
  slicesPerTimepoint: number
): ArrayBuffer {
  if (pixelDataArrays.length === 0) {
    throw new Error("No pixel data found");
  }

  // Determine the data type and size from the reference dataset
  const bitsAllocated = (referenceDataset.BitsAllocated as number) || 16;
  const rows = referenceDataset.Rows as number;
  const columns = referenceDataset.Columns as number;
  const samplesPerPixel = (referenceDataset.SamplesPerPixel as number) || 1;

  const bytesPerPixel = Math.ceil(bitsAllocated / 8);
  const pixelsPerSlice = rows * columns * samplesPerPixel;
  const bytesPerSlice = pixelsPerSlice * bytesPerPixel;
  const bytesPerTimepoint = bytesPerSlice * slicesPerTimepoint;

  // Create a combined buffer for all timepoints
  const totalBytes = bytesPerTimepoint * pixelDataArrays.length;
  const combinedBuffer = new ArrayBuffer(totalBytes);
  const combinedView = new Uint8Array(combinedBuffer);


  let timepointOffset = 0;
  
  for (const timepointPixelData of pixelDataArrays) {
    // Extract pixel data for this timepoint (which contains multiple slices)
    let timepointData: Uint8Array;
    
    if (Array.isArray(timepointPixelData) && timepointPixelData.length === 1) {
      // Enhanced DICOM with single ArrayBuffer containing all slices
      const pixelBuffer = timepointPixelData[0];
      if (pixelBuffer instanceof ArrayBuffer) {
        timepointData = new Uint8Array(pixelBuffer);
      } else if (pixelBuffer instanceof Uint8Array || pixelBuffer instanceof Uint16Array || pixelBuffer instanceof Int16Array) {
        timepointData = new Uint8Array(pixelBuffer.buffer, pixelBuffer.byteOffset, pixelBuffer.byteLength);
      } else {
        console.warn('Unsupported pixel data format for timepoint, skipping');
        timepointOffset += bytesPerTimepoint;
        continue;
      }
    } else {
      console.warn('Unexpected pixel data structure for timepoint, skipping');
      timepointOffset += bytesPerTimepoint;
      continue;
    }

    // Copy timepoint data to combined buffer
    const timepointBytesToCopy = Math.min(timepointData.length, bytesPerTimepoint);
    combinedView.set(timepointData.subarray(0, timepointBytesToCopy), timepointOffset);
    timepointOffset += bytesPerTimepoint;
  }

  return combinedBuffer;
}

function convertDicomSeriesToNifti(series: DicomSeries): Buffer {
  // Read all DICOM files in the series and parse them
  const datasets = series.files.map((filePath) => {
    const buffer = readFileSync(filePath);
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    const dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
    const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
      dicomData.dict
    );
    dataset._meta = dcmjs.data.DicomMetaDictionary.namifyDataset(
      dicomData.meta
    );
    return dataset;
  });

  // Try to normalize the datasets, but fall back to creating NIFTI directly if it fails
  let multiframe;
  try {
    multiframe = dcmjs.normalizers.Normalizer.normalizeToDataset(datasets);
  } catch (error) {
    console.warn(
      `dcmjs normalization failed: ${error}. Creating NIFTI directly from datasets.`
    );
    // Create a pseudo-multiframe dataset from the first dataset with all pixel data
    multiframe = createMultiframeFromDatasets(datasets);
  }

  // Create a basic NIFTI structure from the multiframe data
  const niftiBuffer = createNiftiFromMultiframe(multiframe);

  return niftiBuffer;
}

function convertSingleDicomToNifti(filePath: string): Buffer {
  const buffer = readFileSync(filePath);
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );

  // Parse the DICOM file
  const dicomData = dcmjs.data.DicomMessage.readFile(arrayBuffer);
  const dataset = dcmjs.data.DicomMetaDictionary.naturalizeDataset(
    dicomData.dict
  );
  dataset._meta = dcmjs.data.DicomMetaDictionary.namifyDataset(dicomData.meta);

  const numberOfFrames = dataset.NumberOfFrames as number;

  if (numberOfFrames && numberOfFrames > 1) {
    console.log(`Converting enhanced DICOM with ${numberOfFrames} frames`);
  }

  // Convert single file to NIFTI
  const multiframe = dcmjs.normalizers.Normalizer.normalizeToDataset([dataset]);
  const niftiBuffer = createNiftiFromMultiframe(multiframe);

  return niftiBuffer;
}

function generateOutputPath(
  inputPath: string,
  outputPath: string | undefined,
  series?: DicomSeries,
  seriesIndex?: number
): string {
  if (outputPath) {
    // If output is specified and it's a directory, generate filename
    try {
      const stats = statSync(outputPath);
      if (stats.isDirectory()) {
        if (series) {
          const seriesDesc =
            series.seriesDescription ||
            `series_${series.seriesNumber || seriesIndex || 0}`;
          const cleanDesc = seriesDesc.replace(/[^a-zA-Z0-9_-]/g, "_");
          return join(outputPath, `${cleanDesc}.nii`);
        } else {
          const baseName = basename(inputPath, extname(inputPath));
          return join(outputPath, `${baseName}.nii`);
        }
      }
    } catch {
      // Output path doesn't exist, treat as file path
    }

    // If output path ends with .nii or .nii.gz, use as-is
    if (outputPath.endsWith(".nii") || outputPath.endsWith(".nii.gz")) {
      return outputPath;
    }

    // Otherwise append .nii
    return `${outputPath}.nii`;
  }

  // Generate output path based on input
  const inputDir = statSync(inputPath).isDirectory()
    ? inputPath
    : dirname(inputPath);

  if (series) {
    const seriesDesc =
      series.seriesDescription ||
      `series_${series.seriesNumber || seriesIndex || 0}`;
    const cleanDesc = seriesDesc.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(inputDir, `${cleanDesc}.nii`);
  } else {
    const baseName = basename(inputPath, extname(inputPath));
    return join(inputDir, `${baseName}.nii`);
  }
}

export const dcm2nii = async (options: Dcm2NiiOptions) => {
  const inputStats = statSync(options.input);

  if (inputStats.isDirectory()) {
    // Handle directory input - group by series
    const dicomFiles = getDicomFilesFromDirectory(options.input);

    if (dicomFiles.length === 0) {
      throw new Error(`No DICOM files found in directory: ${options.input}`);
    }

    console.log(`Found ${dicomFiles.length} DICOM files in directory`);

    // Group files by series
    const seriesList = groupDicomFilesBySeries(dicomFiles);

    if (seriesList.length === 0) {
      throw new Error("No valid DICOM series found");
    }

    console.log(`Found ${seriesList.length} DICOM series`);

    // Convert each series to NIFTI
    const outputPaths: string[] = [];
    for (let i = 0; i < seriesList.length; i++) {
      const series = seriesList[i]!;
      console.log(
        `Converting series ${i + 1}/${seriesList.length}: ${
          series.seriesDescription || series.seriesInstanceUID
        } (${series.files.length} files)`
      );

      try {
        const niftiBuffer = convertDicomSeriesToNifti(series);
        const outputPath = generateOutputPath(
          options.input,
          options.output,
          series,
          i
        );

        writeFileSync(outputPath, niftiBuffer);
        outputPaths.push(outputPath);
        console.log(`Saved: ${outputPath}`);
      } catch (error) {
        console.error(
          `Failed to convert series ${series.seriesInstanceUID}: ${error}`
        );
      }
    }

    if (outputPaths.length === 0) {
      throw new Error("Failed to convert any DICOM series to NIFTI");
    }

    console.log(
      `Successfully converted ${outputPaths.length} series to NIFTI format`
    );
  } else {
    // Handle single file input
    console.log(`Converting single DICOM file: ${options.input}`);

    try {
      const niftiBuffer = convertSingleDicomToNifti(options.input);
      const outputPath = generateOutputPath(options.input, options.output);

      writeFileSync(outputPath, niftiBuffer);
      console.log(`Saved: ${outputPath}`);
    } catch (error) {
      throw new Error(`Failed to convert DICOM file to NIFTI: ${error}`);
    }
  }
};

export const dcm2niiCLI = () => {
  return new Command("dcm2nii")
    .description("Convert DICOM files to NIFTI format")
    .requiredOption("-i, --input <path>", "Input DICOM file or directory path")
    .option(
      "-o, --output <path>",
      "Output NIFTI file or directory path (optional)"
    )
    .action(async (options) => {
      try {
        await dcm2nii({
          input: options.input,
          output: options.output,
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
