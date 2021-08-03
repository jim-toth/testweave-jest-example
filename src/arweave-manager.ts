import Arweave from 'arweave'
import { ApiConfig } from 'arweave/node/lib/api'
import { SerializedUploader } from 'arweave/node/lib/transaction-uploader'
import { JWKInterface } from 'arweave/node/lib/wallet'

import { ArweaveTransactionVerificationError } from './error'

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class ArweaveManager {
  config: ApiConfig
  arweave: Arweave
  arweaveJWK: JWKInterface
  uploaders: {
    [key: string]: {
      uploader: SerializedUploader
      data: Uint8Array | ArrayBuffer | undefined
    }
  } = {}

  private normalSleepMs = 2000
  private longSleepMs = 5000

  constructor(config: ApiConfig, jwk: JWKInterface) {
    this.config = config
    this.arweaveJWK = jwk
    this.arweave = Arweave.init(config)
  }

  async resume(transactionId: string): Promise<string> {
    if (!this.uploaders[transactionId]) {
      throw new Error('Transaction ID not found')
    }

    const uploader = await this.arweave.transactions.getUploader(
      this.uploaders[transactionId].uploader,
      this.uploaders[transactionId].data
    )
    try {
      while (!uploader.isComplete) {
        await uploader.uploadChunk()
      }
    } catch (error) {
      throw new ArweaveTransactionVerificationError(error, transactionId)
    }

    delete this.uploaders[transactionId]

    return transactionId
  }

  async upload(
    data: string | Uint8Array | ArrayBuffer,
    contentType: string = 'application/octet-stream'
  ): Promise<string> {
    const transaction = await this.arweave.createTransaction(
      { data },
      this.arweaveJWK
    )
    transaction.addTag('Content-Type', contentType)
    await this.arweave.transactions.sign(transaction, this.arweaveJWK)

    const uploader = await this.arweave.transactions.getUploader(transaction)
    const cachedUploader = {
      uploader: uploader.toJSON(),
      data: typeof data === 'string' ? new TextEncoder().encode(data) : data
    }
    this.uploaders[transaction.id] = cachedUploader

    while (!uploader.isComplete) {
      try {
        await uploader.uploadChunk()
      } catch (error) {
        if (!(error as Error).toString().includes('429')) {
          throw new ArweaveTransactionVerificationError(error, transaction.id)
        } else {
          await sleep(this.longSleepMs)
        }
      }
    }

    let { status } = await this.arweave.transactions.getStatus(transaction.id)
    await sleep(this.normalSleepMs)

    while (status && [202, 429].includes(status)) {
      // console.log(`ArweaveManager(${transaction.id}) -> ${status} status, waiting for 200`)

      const resp = await this.arweave.transactions.getStatus(transaction.id)
      status = resp.status
      status === 202
        ? await sleep(this.normalSleepMs)
        : await sleep(this.longSleepMs)
    }

    switch (status && status.toString()[0]) {
      case '2':
        break
      case '4':
        throw new Error('Invalid Arweave Transaction: ' + status)
      case '5':
        throw new Error('Arweave Transaction Error: ' + status)
      default:
        throw new Error('Unhandled Arweave Status: ' + status)
    }

    delete this.uploaders[transaction.id]

    return transaction.id
  }
}
