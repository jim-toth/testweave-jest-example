import Arweave from 'arweave'
import Api, { ApiConfig } from 'arweave/node/lib/api'
import Transaction from 'arweave/node/lib/transaction'
import { TransactionUploader } from 'arweave/node/lib/transaction-uploader'
import { JWKInterface } from 'arweave/node/lib/wallet'

import { ArweaveManager } from '../src/arweave-manager'
import { isArweaveTransactionVerificationError } from '../src/error'

jest.mock('arweave', () => {
  return { init: jest.fn() }
})

const SIGNED_TRANSACTION_ID = 'signed-transaction-id'
const DEFAULT_TRANSACTION_STATUS = 200
let theTransaction: Transaction
let mockUploader: TransactionUploader
const setupArweaveMock = (
  statuses: number[] = [DEFAULT_TRANSACTION_STATUS]
): void => {
  theTransaction = new Transaction({ id: 'unsigned' })
  theTransaction.addTag = jest.fn()
  theTransaction.chunks = {
    data_root: new Uint8Array(),
    chunks: [],
    proofs: []
  }

  mockUploader = new TransactionUploader(new Api({}), theTransaction)

  const mockGetStatus = jest.fn()
  const mockPost = jest.fn()
  const mockUploadChunk = jest.fn()
  const _uploadChunk = (status: number) => {
    return () => {
      if (status.toString().startsWith('2')) {
        mockUploader['txPosted'] = true
      } else {
        throw new Error(status.toString())
      }
    }
  }

  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i]
    const txStatusResponse = {
      status,
      confirmed: status.toString().startsWith('2')
        ? {
            block_height: 0,
            block_indep_hash: 'test-hash',
            number_of_confirmations: 0
          }
        : null
    }
    if (i === statuses.length - 1) {
      mockGetStatus.mockResolvedValue(txStatusResponse)
      mockPost.mockResolvedValue(txStatusResponse)
      mockUploadChunk.mockImplementation(_uploadChunk(status))
    } else {
      mockGetStatus.mockResolvedValueOnce(txStatusResponse)
      mockPost.mockResolvedValueOnce(txStatusResponse)
      mockUploadChunk.mockImplementationOnce(_uploadChunk(status))
    }
  }

  mockUploader.uploadChunk = mockUploadChunk
  ;(Arweave.init as jest.Mock).mockReturnValue({
    createTransaction: jest.fn().mockResolvedValue(theTransaction),
    transactions: {
      sign: jest.fn().mockImplementation(async (transaction: Transaction) => {
        transaction.id = SIGNED_TRANSACTION_ID
      }),
      post: mockPost,
      getStatus: mockGetStatus,
      getUploader: jest
        .fn()
        .mockImplementation(async (_transaction: Transaction) => {
          return mockUploader
        })
    }
  })
}

const DEFAULT_ARWEAVE_CONFIG = {}
const DEFAULT_ARWEAVE_JWK = { kty: '', e: '', n: '' }
const setupArweaveManager = (
  config: ApiConfig = DEFAULT_ARWEAVE_CONFIG,
  jwk: JWKInterface = DEFAULT_ARWEAVE_JWK
): ArweaveManager => {
  return new ArweaveManager(config, jwk)
}

const htmlData = `
<html>
  <head>
    <meta charset="UTF-8">
    <title>Info about arweave</title>
  </head>
  <body>
    Arweave is the best web3-related thing out there!!!
  </body>
</html>`

describe('ArweaveManager', () => {
  it('initializes Arweave library', () => {
    setupArweaveMock()
    const arweaveManager = setupArweaveManager()

    expect(arweaveManager).not.toBeNull()
    expect(Arweave.init).toBeCalledWith(DEFAULT_ARWEAVE_CONFIG)
  })

  it('uploads to Arweave', async () => {
    setupArweaveMock([202, 200])
    const arweaveManager = setupArweaveManager()

    const transactionId = await arweaveManager.upload(htmlData)

    expect(arweaveManager.arweave.createTransaction).toHaveBeenCalledWith(
      { data: htmlData },
      DEFAULT_ARWEAVE_JWK
    )
    expect(arweaveManager.arweave.transactions.sign).toHaveBeenCalledWith(
      theTransaction,
      DEFAULT_ARWEAVE_JWK
    )
    expect(
      arweaveManager.arweave.transactions.getUploader
    ).toHaveBeenCalledWith(theTransaction)
    expect(mockUploader.uploadChunk).toHaveBeenCalled()
    expect(arweaveManager.arweave.transactions.getStatus).toHaveBeenCalledWith(
      theTransaction.id
    )
    expect(transactionId).toEqual(SIGNED_TRANSACTION_ID)
    expect(arweaveManager.uploaders[transactionId]).toBeFalsy()
  })

  it('throws when transaction invalid', async () => {
    setupArweaveMock([400])
    const arweaveManager = setupArweaveManager()

    await expect(async () => {
      await arweaveManager.upload(htmlData)
    }).rejects.toThrow()
  })

  it('throws when transaction error', async () => {
    setupArweaveMock([500])
    const arweaveManager = setupArweaveManager()

    await expect(async () => {
      await arweaveManager.upload(htmlData)
    }).rejects.toThrow()
  })

  it('throws when unhandled arweave status', async () => {
    setupArweaveMock([666])
    const arweaveManager = setupArweaveManager()

    await expect(async () => {
      await arweaveManager.upload(htmlData)
    }).rejects.toThrow()
  })

  it('tags mime types', async () => {
    setupArweaveMock()
    const arweaveManager = setupArweaveManager()

    await arweaveManager.upload(htmlData)

    expect(theTransaction.addTag).toHaveBeenNthCalledWith(
      1,
      'Content-Type',
      'application/octet-stream'
    )

    await arweaveManager.upload(htmlData, 'text/html')

    expect(theTransaction.addTag).toHaveBeenNthCalledWith(
      2,
      'Content-Type',
      'text/html'
    )
  })

  it('throws when invalid transaction id is resumed', async () => {
    setupArweaveMock()
    const arweaveManager = setupArweaveManager()

    await expect(async () => {
      await arweaveManager.resume('invalid transaction id')
    }).rejects.toThrow('Transaction ID not found')
  })

  it('resumes failed uploads', async done => {
    setupArweaveMock([400, 202])
    const arweaveManager = setupArweaveManager()

    let txId = '',
      errTxId = ''
    try {
      await arweaveManager.upload(htmlData)
    } catch (error) {
      if (isArweaveTransactionVerificationError(error)) {
        errTxId = error.transactionId
      } else {
        console.error(error)
      }
    }

    expect(errTxId).toBeTruthy()

    const uploader = arweaveManager.uploaders[errTxId]

    expect(uploader).toBeTruthy()

    txId = await arweaveManager.resume(errTxId)

    expect(
      arweaveManager.arweave.transactions.getUploader
    ).toHaveBeenCalledWith(uploader.uploader, uploader.data)
    expect(mockUploader.uploadChunk).toHaveBeenCalled()
    expect(txId).toEqual(errTxId)
    expect(arweaveManager.uploaders[errTxId]).toBeFalsy()
    done()
  })
})
