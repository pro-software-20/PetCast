import type { TaskAnalysisFile } from '../types/taskAnalysis'

const MEBIBYTE = 1024 * 1024

export const MAX_TASK_ANALYSIS_FILES = 20
export const MAX_TASK_ANALYSIS_FILE_SIZE = 100 * MEBIBYTE
export const MAX_TASK_ANALYSIS_TOTAL_SIZE = 500 * MEBIBYTE

export interface TaskAnalysisFileRejections {
  duplicate: number
  tooLarge: number
  fileCount: number
  totalSize: number
}

export interface TaskAnalysisFileSelection {
  files: TaskAnalysisFile[]
  addedCount: number
  rejected: TaskAnalysisFileRejections
  notice: string | null
}

const fileKey = (file: TaskAnalysisFile) => `${file.name}\u0000${file.type}\u0000${file.size}`

const sizeForLimit = (file: TaskAnalysisFile) => (
  Number.isFinite(file.size) && file.size >= 0 ? file.size : 0
)

const formatMebibytes = (bytes: number) => `${bytes / MEBIBYTE} MiB`

const createNotice = (
  incomingCount: number,
  addedCount: number,
  rejected: TaskAnalysisFileRejections,
) => {
  if (incomingCount === 0) return null

  const reasons = [
    rejected.duplicate > 0 ? `${rejected.duplicate} 个重复文件` : null,
    rejected.tooLarge > 0 ? `${rejected.tooLarge} 个超过 ${formatMebibytes(MAX_TASK_ANALYSIS_FILE_SIZE)}` : null,
    rejected.fileCount > 0 ? `${rejected.fileCount} 个超过 ${MAX_TASK_ANALYSIS_FILES} 个数量限制` : null,
    rejected.totalSize > 0 ? `${rejected.totalSize} 个超过 ${formatMebibytes(MAX_TASK_ANALYSIS_TOTAL_SIZE)} 总大小限制` : null,
  ].filter((reason): reason is string => Boolean(reason))

  const addedMessage = addedCount > 0
    ? `已添加 ${addedCount} 个文件。`
    : '未添加新文件。'

  return reasons.length > 0
    ? `${addedMessage}已跳过：${reasons.join('，')}。`
    : addedMessage
}

export function mergeTaskAnalysisFiles(
  currentFiles: TaskAnalysisFile[],
  incomingFiles: TaskAnalysisFile[],
): TaskAnalysisFileSelection {
  const files = [...currentFiles]
  const seen = new Set(currentFiles.map(fileKey))
  let totalSize = currentFiles.reduce((sum, file) => sum + sizeForLimit(file), 0)
  let addedCount = 0
  const rejected: TaskAnalysisFileRejections = {
    duplicate: 0,
    tooLarge: 0,
    fileCount: 0,
    totalSize: 0,
  }

  for (const file of incomingFiles) {
    const key = fileKey(file)
    if (seen.has(key)) {
      rejected.duplicate += 1
      continue
    }
    seen.add(key)

    const size = sizeForLimit(file)
    if (size > MAX_TASK_ANALYSIS_FILE_SIZE) {
      rejected.tooLarge += 1
      continue
    }
    if (files.length >= MAX_TASK_ANALYSIS_FILES) {
      rejected.fileCount += 1
      continue
    }
    if (totalSize + size > MAX_TASK_ANALYSIS_TOTAL_SIZE) {
      rejected.totalSize += 1
      continue
    }

    files.push(file)
    totalSize += size
    addedCount += 1
  }

  return {
    files,
    addedCount,
    rejected,
    notice: createNotice(incomingFiles.length, addedCount, rejected),
  }
}
