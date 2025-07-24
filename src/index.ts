import { Command } from "commander";
import { nii2pngCLI } from "./nii2png/nii2png";
import { dcm2pngCLI } from "./dcm2png/dcm2png";
import { dcm2niiCLI } from "./dcm2nii/dcm2nii";

export { nii2png } from "./nii2png/nii2png";
export { dcm2png } from "./dcm2png/dcm2png";
export { dcm2nii } from "./dcm2nii/dcm2nii";

if (import.meta.main) {
  const program = new Command();

  program
    .name("egami")
    .description("CLI tools for medical imaging")
    .version("1.0.0");

  program.addCommand(nii2pngCLI());
  program.addCommand(dcm2pngCLI());
  program.addCommand(dcm2niiCLI());

  program.parse();
}
