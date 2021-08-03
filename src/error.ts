export class ArweaveTransactionVerificationError extends Error {
  transactionId: string

  constructor(error: Error, transactionId: string) {
    super(error.message)
    this.name = this.constructor.name
    this.transactionId = transactionId
  }
}

export function isArweaveTransactionVerificationError(
  error: Error
): error is ArweaveTransactionVerificationError {
  return (
    (error as ArweaveTransactionVerificationError).transactionId !== 'undefined'
  )
}
