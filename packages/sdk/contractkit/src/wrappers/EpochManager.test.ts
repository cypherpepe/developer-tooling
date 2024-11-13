import { newElection } from '@celo/abis-12/web3/Election'
import { testWithAnvilL2, withImpersonatedAccount } from '@celo/dev-utils/lib/anvil-test'
import { timeTravel } from '@celo/dev-utils/lib/ganache-test'
import BigNumber from 'bignumber.js'
import Web3 from 'web3'
import { newKitFromWeb3 } from '../kit'
import { startAndFinishEpochProcess } from '../test-utils/utils'

process.env.NO_SYNCCHECK = 'true'

testWithAnvilL2('EpochManagerWrapper', (web3: Web3) => {
  const kit = newKitFromWeb3(web3)

  const SECONDS_PER_BLOCK = 5
  const BLOCKS_PER_EPOCH = 17280
  const EPOCH_DURATION = BLOCKS_PER_EPOCH * SECONDS_PER_BLOCK

  it('has the correct address for the EpochManager contract', async () => {
    const epochManagerWrapper = await kit.contracts.getEpochManager()

    expect(epochManagerWrapper.address).toMatchInlineSnapshot(
      `"0x2E290D8c2D6b26985f2826A63Aa103963DbAca23"`
    )
  })

  it('indicates that it is time for next epoch', async () => {
    const epochManagerWrapper = await kit.contracts.getEpochManager()

    await timeTravel(EPOCH_DURATION + 1, web3)

    expect(await epochManagerWrapper.isTimeForNextEpoch()).toBeTruthy()

    await startAndFinishEpochProcess(kit)

    expect(await epochManagerWrapper.isTimeForNextEpoch()).toBeFalsy()
  })

  it('gets elected validators', async () => {
    const epochManagerWrapper = await kit.contracts.getEpochManager()

    expect(await epochManagerWrapper.getElectedAccounts()).toMatchInlineSnapshot(`
      [
        "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
        "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
        "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
        "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
        "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
        "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
      ]
    `)
  })

  it('gets current epoch processing status', async () => {
    const epochManagerWrapper = await kit.contracts.getEpochManager()
    const accounts = await web3.eth.getAccounts()

    expect((await epochManagerWrapper.getEpochProcessingStatus()).status).toEqual(0)

    // Let the epoch pass and start another one
    await timeTravel(EPOCH_DURATION, web3)
    await epochManagerWrapper.startNextEpochProcess().sendAndWaitForReceipt({
      from: accounts[0],
    })

    expect((await epochManagerWrapper.getEpochProcessingStatus()).status).toEqual(1)
  })

  it('gets first known epoch number', async () => {
    const epochManagerWrapper = await kit.contracts.getEpochManager()

    expect(await epochManagerWrapper.firstKnownEpoch()).toEqual(4)
  })

  it('gets block numbers for an epoch', async () => {
    const epochManagerWrapper = await kit.contracts.getEpochManager()
    const currentEpochNumber = await epochManagerWrapper.getCurrentEpochNumber()
    const accounts = await web3.eth.getAccounts()

    expect(await epochManagerWrapper.getFirstBlockAtEpoch(currentEpochNumber)).toEqual(300)
    await expect(
      epochManagerWrapper.getLastBlockAtEpoch(currentEpochNumber)
    ).rejects.toMatchInlineSnapshot(`[Error: execution reverted: revert: Epoch not finished yet]`)

    // Let the epoch pass and start another one
    await timeTravel(EPOCH_DURATION + 1, web3)
    await epochManagerWrapper.startNextEpochProcess().sendAndWaitForReceipt({
      from: accounts[0],
    })
    await (
      await epochManagerWrapper.finishNextEpochProcessTx()
    ).sendAndWaitForReceipt({
      from: accounts[0],
    })

    expect(await epochManagerWrapper.getLastBlockAtEpoch(currentEpochNumber)).toEqual(352)
  })

  async function activateValidators() {
    const validatorsContract = await kit.contracts.getValidators()
    const electionWrapper = await kit.contracts.getElection()
    const electionContract = newElection(web3, electionWrapper.address)
    const validatorGroups = await validatorsContract.getRegisteredValidatorGroupsAddresses()

    for (const validatorGroup of validatorGroups) {
      const pendingVotesForGroup = new BigNumber(
        await electionContract.methods.getPendingVotesForGroup(validatorGroup).call()
      )
      if (pendingVotesForGroup.gt(0)) {
        await withImpersonatedAccount(
          web3,
          validatorGroup,
          async () => {
            await electionContract.methods.activate(validatorGroup).send({ from: validatorGroup })
          },
          new BigNumber(web3.utils.toWei('1', 'ether'))
        )
      }
    }
  }

  it('starts and finishes a number of epochs', async () => {
    const accounts = await kit.web3.eth.getAccounts()
    const epochManagerWrapper = await kit.contracts.getEpochManager()
    const EPOCH_COUNT = 5

    await timeTravel(EPOCH_DURATION, web3)

    await startAndFinishEpochProcess(kit)

    await activateValidators()

    expect(await epochManagerWrapper.getCurrentEpochNumber()).toEqual(5)

    for (let i = 0; i < EPOCH_COUNT; i++) {
      await timeTravel(EPOCH_DURATION + 1, web3)

      await startAndFinishEpochProcess(kit)
    }

    expect(await epochManagerWrapper.getCurrentEpochNumber()).toEqual(10)
    expect((await epochManagerWrapper.getEpochProcessingStatus()).status).toEqual(0)

    // Start a new epoch process, but not finish it, so we can check the amounts
    await timeTravel(EPOCH_DURATION + 1, web3)
    await epochManagerWrapper.startNextEpochProcess().sendAndWaitForReceipt({
      from: accounts[0],
    })

    const status = await epochManagerWrapper.getEpochProcessingStatus()

    expect(status.totalRewardsVoter.toNumber()).toBeGreaterThan(0)
    expect(status.perValidatorReward.toNumber()).toBeGreaterThan(0)
    expect(status.totalRewardsCommunity.toNumber()).toBeGreaterThan(0)
    expect(status.totalRewardsCarbonFund.toNumber()).toBeGreaterThan(0)
  })
})