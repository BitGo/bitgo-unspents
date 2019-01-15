const _ = require('lodash');
require('lodash.combinations');

const should = require('should');

const HDKey = require('hdkey');
const bitcoin = require('bitgo-utxo-lib');

const utxo = require('../src');

const {
  UnspentTypeScript2of3,
  UnspentTypePubKeyHash,
  UnspentTypeOpReturn,
  getInputDimensionsForUnspentType,
  getOutputDimensionsForUnspentType,
} = require('./testutils');


/**
 * Return a 2-of-3 multisig output
 * @param keys - the key array for multisig
 * @param unspentType - one of UnspentTypeScript2of3
 * @returns {{redeemScript, witnessScript, address}}
 */
const createOutputScript2of3 = (keys, unspentType) => {
  const pubkeys = keys.map(({ publicKey }) => publicKey);
  const script2of3 = bitcoin.script.multisig.output.encode(2, pubkeys);
  const p2wshOutputScript = bitcoin.script.witnessScriptHash.output.encode(
    bitcoin.crypto.sha256(script2of3)
  );
  let redeemScript, witnessScript;
  switch (unspentType) {
    case UnspentTypeScript2of3.p2sh:
      redeemScript = script2of3;
      break;
    case UnspentTypeScript2of3.p2shP2wsh:
      witnessScript = script2of3;
      redeemScript = p2wshOutputScript;
      break;
    case UnspentTypeScript2of3.p2wsh:
      witnessScript = script2of3;
      break;
    default:
      throw new Error(`unknown multisig output type ${unspentType}`);
  }

  let scriptPubKey;
  if (unspentType === UnspentTypeScript2of3.p2wsh) {
    scriptPubKey = p2wshOutputScript;
  } else {
    const redeemScriptHash = bitcoin.crypto.hash160(redeemScript);
    scriptPubKey = bitcoin.script.scriptHash.output.encode(redeemScriptHash);
  }

  return { redeemScript, witnessScript, scriptPubKey };
};


/**
 *
 * @param keys - Pubkeys to use for generating the address.
 *               If unspentType is one of UnspentTypePubKeyHash is used, the first key will be used.
 * @param unspentType {String} - one of UnspentTypeScript2of3 or UnspentTypePubKeyHash
 * @return {String} address
 */
const createScriptPubKey = (keys, unspentType) => {
  if (UnspentTypeScript2of3[unspentType]) {
    return createOutputScript2of3(keys, unspentType).scriptPubKey;
  }

  const key = keys[0];
  const pkHash = bitcoin.crypto.hash160(key.publicKey);
  switch (unspentType) {
    case UnspentTypePubKeyHash.p2pkh:
      return bitcoin.script.pubKeyHash.output.encode(pkHash);
    case UnspentTypePubKeyHash.p2wpkh:
      return bitcoin.script.witnessPubKeyHash.output.encode(pkHash);
  }

  if (unspentType instanceof UnspentTypeOpReturn) {
    const payload = Array(unspentType.size).fill('01');
    return bitcoin.script.nullData.output.encode(payload);
  }

  throw new Error(`unsupported output type ${unspentType}`);
};


const createInputTx = (unspents, inputValue) => {
  const txInputBuilder = new bitcoin.TransactionBuilder();
  txInputBuilder.addInput(Array(32).fill('01').join(''), 0);
  unspents.forEach(({ scriptPubKey }) => txInputBuilder.addOutput(scriptPubKey, inputValue));
  return txInputBuilder.buildIncomplete();
};


class TxCombo {
  constructor(keys, inputTypes, outputTypes, expectedDims, inputValue = 10) {
    this.keys = keys;
    this.inputTypes = inputTypes;
    this.outputTypes = outputTypes;
    this.unspents = inputTypes.map((inputType) => createOutputScript2of3(keys, inputType));
    this.inputTx = createInputTx(this.unspents, inputValue);
    this.expectedDims = expectedDims;
    this.inputValue = inputValue;
  }

  getBuilderWithUnsignedTx() {
    const txBuilder = new bitcoin.TransactionBuilder();
    this.inputTx.outs.forEach(({}, i) => txBuilder.addInput(this.inputTx, i));
    this.outputTypes.forEach(
      unspentType => txBuilder.addOutput(createScriptPubKey(this.keys, unspentType), this.inputValue)
    );
    return txBuilder;
  }

  getUnsignedTx() {
    return this.getBuilderWithUnsignedTx().tx;
  }

  getSignedTx() {
    const txBuilder = this.getBuilderWithUnsignedTx();
    this.unspents.forEach(({ redeemScript, witnessScript }, i) =>
      this.keys.slice(0, 2).forEach((key) =>
        txBuilder.sign(
          i,
          key,
          redeemScript,
          undefined /* hashType */,
          this.inputValue /* needed for segwit signatures */,
          witnessScript
        )
      )
    );
    return txBuilder.build();
  }
}

const testDimensionsFromTx = (txCombo) => {
  const { inputTypes, outputTypes, expectedDims } = txCombo;

  describe(`Combination inputs=${inputTypes}; outputs=${outputTypes}`, function () {
    const nInputs = inputTypes.length;
    const outputDims = utxo.Dimensions.sum(...outputTypes.map(getOutputDimensionsForUnspentType));

    it(`calculates dimensions from unsigned transaction`, function () {
      const unsignedTx = txCombo.getUnsignedTx();

      // does not work for unsigned transactions
      should.throws(() => utxo.Dimensions.fromTransaction(unsignedTx));

      // unless explicitly allowed
      utxo.Dimensions.fromTransaction(unsignedTx, { assumeUnsigned: utxo.Dimensions.ASSUME_P2SH })
        .should.eql(utxo.Dimensions.sum({ nP2shInputs: nInputs }, outputDims));

      utxo.Dimensions.fromTransaction(unsignedTx, { assumeUnsigned: utxo.Dimensions.ASSUME_P2SH_P2WSH })
        .should.eql(utxo.Dimensions.sum({ nP2shP2wshInputs: nInputs }, outputDims));

      utxo.Dimensions.fromTransaction(unsignedTx, { assumeUnsigned: utxo.Dimensions.ASSUME_P2WSH })
        .should.eql(utxo.Dimensions.sum({ nP2wshInputs: nInputs }, outputDims));
    });

    it(`calculates dimensions for signed transaction`, function () {
      const dimensions = utxo.Dimensions.fromTransaction(txCombo.getSignedTx());
      dimensions.should.eql(expectedDims);
    });

    it(`calculates dimensions for signed input of transaction`, function () {
      const signedTx = txCombo.getSignedTx();

      // test Dimensions.fromInput()
      inputTypes.forEach((input, i) =>
        utxo.Dimensions.fromInput(signedTx.ins[i])
          .should.eql(utxo.Dimensions.sum(getInputDimensionsForUnspentType(input)))
      );
    });
  });
};


const runAllCombinations = (inputTypes, outputTypes, callback) => {
  // Create combinations of different input and output types. Length between 1 and 3.
  const inputCombinations = _.flatten([1, 2, 3].map(i => _.combinations(inputTypes, i)));
  const outputCombinations = _.flatten([1, 2, 3].map(i => _.combinations(outputTypes, i)));

  inputCombinations.forEach(inputTypeCombo =>
    outputCombinations.forEach(outputTypeCombo => {
      callback(inputTypeCombo, outputTypeCombo);
    })
  );
};


describe(`Dimensions for transaction combinations`, function () {
  const inputTypes = Object.keys(UnspentTypeScript2of3);
  const outputTypes = [...inputTypes, ...Object.keys(UnspentTypePubKeyHash)];

  runAllCombinations(inputTypes, outputTypes, (inputTypeCombo, outputTypeCombo) => {
    const expectedInputDims = utxo.Dimensions.sum(...inputTypeCombo.map(getInputDimensionsForUnspentType));
    const expectedOutputDims = utxo.Dimensions.sum(...outputTypeCombo.map(getOutputDimensionsForUnspentType));

    const keys = [1, 2, 3].map((v) => HDKey.fromMasterSeed(Buffer.from(`test/2/${v}`)));

    testDimensionsFromTx(
      new TxCombo(
        keys,
        inputTypeCombo,
        outputTypeCombo,
        expectedInputDims.plus(expectedOutputDims)
      )
    );

    // Doubling the inputs should yield twice the input dims
    testDimensionsFromTx(
      new TxCombo(
        keys,
        [...inputTypeCombo, ...inputTypeCombo],
        outputTypeCombo,
        expectedInputDims.plus(expectedInputDims).plus(expectedOutputDims)
      )
    );

    // Same for outputs
    testDimensionsFromTx(
      new TxCombo(
        keys,
        inputTypeCombo,
        [...outputTypeCombo, ...outputTypeCombo],
        expectedInputDims.plus(expectedOutputDims).plus(expectedOutputDims)
      )
    );
  });
});


describe(`Dimension estimation errors`, function () {
  const inputTypes = Object.keys(UnspentTypeScript2of3);
  const outputTypes = [
    ...inputTypes,
    ...Object.keys(UnspentTypePubKeyHash),
    new UnspentTypeOpReturn(16),
    new UnspentTypeOpReturn(32)
  ];

  /* eslint-disable no-multi-spaces, array-bracket-spacing */
  const expectedInputErrors = new Map([
    [UnspentTypeScript2of3.p2sh,      [-1, 3]],
    [UnspentTypeScript2of3.p2shP2wsh, [ 0, 0]],
    [UnspentTypeScript2of3.p2wsh,     [ 1, 1]],
  ]);
  /* eslint-enable no-multi-spaces, array-bracket-spacing */

  class ErrorTracker {
    constructor() {
      this.map = new Map();
      this.total = 0;
    }

    add(size) {
      this.map.set(size, (this.map.get(size) || 0) + 1);
      this.total++;
    }

    getPercentile(p) {
      if (0 > p || p > 1) {
        throw new Error(`p must be between 0 and 1`);
      }

      const sortedKeys = [...this.map.keys()].sort((a, b) => a - b);
      let sum = 0;
      for (const k of sortedKeys) {
        sum += this.map.get(k);
        if ((sum / this.total) >= p) {
          return k;
        }
      }

      throw new Error('could not find percentile');
    }

    toString() {
      const keys = [...this.map.keys()].sort((a, b) => a - b);
      return `[${keys.map((k) => `[${k}, ${this.map.get(k)}]`).join(' ')}]`;
    }
  }

  const getKeyTriplets = (prefix, count) => [...Array(count)].map(
    (_, i) => [1, 2, 3].map((j) => HDKey.fromMasterSeed(Buffer.from(`${prefix}/${i}/${j}`)))
  );

  const inputKeyTriplets = getKeyTriplets('test/input/', 8);
  const outputKeyTriplets = getKeyTriplets('test/output/', 16);
  const outputValue = 1e8;

  inputTypes.forEach((inputType) => {
    const inputTxs = inputKeyTriplets
      .map((inputKeys) => {
        const unspent = createOutputScript2of3(inputKeys, inputType);
        const inputTx = createInputTx([unspent], outputValue);
        return { inputKeys, unspent, inputTx };
      });

    outputTypes.forEach((outputType) => {
      const outputs = outputKeyTriplets.map((outputKeys) => createScriptPubKey(outputKeys, outputType));

      it(`should have correct vsize error bounds for input=${inputType} and output=${outputType}`, function () {
        this.timeout(20000);
        const inputVSizeErrors = new ErrorTracker();
        inputTxs.forEach(({ inputKeys, unspent, inputTx }) => {
          const txBuilder = new bitcoin.TransactionBuilder(undefined, Infinity);
          inputTx.outs.forEach((_, i) => txBuilder.addInput(inputTx, i));

          outputs.forEach((scriptPubKey) => {
            txBuilder.tx.outs = [];
            txBuilder.inputs.forEach((i) => { delete i.signatures; });
            txBuilder.addOutput(scriptPubKey, outputValue);
            const { redeemScript, witnessScript } = unspent;
            inputKeys.slice(0, 2).forEach(key => txBuilder.sign(
              0,
              key,
              redeemScript,
              undefined, /* hashType */
              outputValue,
              witnessScript
            ));
            const tx = txBuilder.build();
            const dims = utxo.Dimensions.fromTransaction(tx);

            const totalVSize = tx.virtualSize();
            const outputsVSize = totalVSize - Object.assign(tx.clone(), { outs: [] }).virtualSize();
            const outputVSizeError = (dims.getOutputsVSize() - outputsVSize);
            outputVSizeError.should.eql(0);

            const overheadPlusInputsVSize = totalVSize - outputsVSize;
            const inputVSizeError = (dims.getOverheadVSize() + dims.getInputsVSize()) - overheadPlusInputsVSize;
            inputVSizeErrors.add(inputVSizeError);
          });
        });

        // console.log(`inputType=${inputType} outputType=${outputType}\n`);
        // console.log(`inputVSizeErrors`, inputVSizeErrors);

        [
          inputVSizeErrors.getPercentile(0.01),
          inputVSizeErrors.getPercentile(0.99)
        ].should.eql(expectedInputErrors.get(inputType));
      });
    });
  });
});