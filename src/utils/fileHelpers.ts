/**
 * ファイルの拡張子を小文字で返す
 */
export const getExtension = (filename: string): string => {
  const idx = filename.lastIndexOf('.');
  return idx >= 0 ? filename.slice(idx).toLowerCase() : '';
};

/**
 * ファイルが VRM かどうかチェック
 */
export const isVRMFile = (file: File): boolean =>
  getExtension(file.name) === '.vrm';

/**
 * ファイルが VRMA かどうかチェック
 */
export const isVRMAFile = (file: File): boolean =>
  getExtension(file.name) === '.vrma';

/**
 * FileList または File[] から最初の VRM ファイルを返す
 */
export const extractVRMFile = (files: FileList | File[]): File | null => {
  const arr = Array.from(files);
  return arr.find(isVRMFile) ?? null;
};

/**
 * FileList または File[] から全 VRMA ファイルを返す
 */
export const extractVRMAFiles = (files: FileList | File[]): File[] => {
  return Array.from(files).filter(isVRMAFile);
};

/**
 * ファイルが VMD かどうかチェック
 */
export const isVMDFile = (file: File): boolean =>
  getExtension(file.name) === '.vmd';

/**
 * FileList または File[] から全 VMD ファイルを返す
 */
export const extractVMDFiles = (files: FileList | File[]): File[] => {
  return Array.from(files).filter(isVMDFile);
};
