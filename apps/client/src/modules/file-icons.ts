import {
  FileArchive, FileAudio, FileCode, FileCsv, FileDoc, FileHtml, FileImage, FileJs,
  FileMd, FilePdf, FilePng, FilePpt, FilePy, FileSql, FileSvg, FileText,
  FileTxt, FileVideo, FileXls, FileZip, type Icon,
} from "@phosphor-icons/react";

/**
 * 按扩展名给文件配图标。只做「一眼能分辨类型」的粗分类，不追求覆盖所有后缀：
 * 认不出来的走 FileText，不会出现空白。
 */
const byExtension: Record<string, Icon> = {
  // 图片
  jpg: FileImage, jpeg: FileImage, heic: FileImage, webp: FileImage, bmp: FileImage, tif: FileImage,
  tiff: FileImage, avif: FileImage, gif: FileImage, png: FilePng, svg: FileSvg,
  // 视频（含 STRM：内容是外部播放地址的文本，按视频对待）
  mp4: FileVideo, mkv: FileVideo, mov: FileVideo, avi: FileVideo, wmv: FileVideo, flv: FileVideo,
  m4v: FileVideo, mpg: FileVideo, mpeg: FileVideo, m2ts: FileVideo, rmvb: FileVideo,
  // .ts 在 NAS 上既是 TypeScript 也是 MPEG-TS：按视频处理（用户实际会遇到的是录制文件）
  ts: FileVideo,
  rm: FileVideo, webm: FileVideo, strm: FileVideo, iso: FileVideo, vob: FileVideo,
  // 音频
  mp3: FileAudio, flac: FileAudio, wav: FileAudio, aac: FileAudio, m4a: FileAudio, ape: FileAudio,
  ogg: FileAudio, wma: FileAudio, dsf: FileAudio, dff: FileAudio, opus: FileAudio, aiff: FileAudio,
  // 压缩包
  zip: FileZip, rar: FileZip, "7z": FileZip, tar: FileArchive, gz: FileArchive, bz2: FileArchive,
  xz: FileArchive, tgz: FileArchive,
  // 文档
  pdf: FilePdf, doc: FileDoc, docx: FileDoc, xls: FileXls, xlsx: FileXls, csv: FileCsv,
  ppt: FilePpt, pptx: FilePpt, txt: FileTxt, log: FileTxt, md: FileMd, rtf: FileDoc,
  // 代码与配置
  js: FileJs, mjs: FileJs, cjs: FileJs, tsx: FileCode, jsx: FileJs, json: FileCode,
  html: FileHtml, htm: FileHtml, css: FileHtml, py: FilePy, sql: FileSql, ini: FileText,
  conf: FileText, yml: FileText, yaml: FileText, toml: FileText, sh: FileCode, go: FileCode,
  rs: FileCode, java: FileCode, c: FileCode, cpp: FileCode, h: FileCode,
};

/** 取扩展名（小写、不含点）。没有扩展名返回空串。 */
export function fileExtension(name: string): string {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) return "";
  return trimmed.slice(dot + 1).toLowerCase();
}

export function fileIconFor(name: string): Icon {
  return byExtension[fileExtension(name)] ?? FileText;
}
