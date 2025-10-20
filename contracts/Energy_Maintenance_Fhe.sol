pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract EnergyMaintenanceFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct Batch {
        uint256 id;
        bool open;
        uint256 dataCount;
        euint32 encryptedTotalVibration;
        euint32 encryptedMaxTemperature;
    }
    uint256 public currentBatchId;
    mapping(uint256 => Batch) public batches;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address account);
    event Unpaused(address account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event DataSubmitted(address indexed provider, uint256 indexed batchId, uint256 dataCount);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint32 totalVibration, uint32 maxTemperature);

    error NotOwner();
    error NotProvider();
    error PausedState();
    error CooldownActive();
    error BatchNotOpen();
    error BatchOpen();
    error InvalidBatch();
    error ReplayAttempt();
    error StateMismatch();
    error DecryptionFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedState();
        _;
    }

    modifier respectCooldown(address _address, uint256 _lastTime, string memory _action) {
        if (block.timestamp < _lastTime + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
        cooldownSeconds = 60; // Default cooldown: 1 minute
    }

    function transferOwnership(address newOwner) external onlyOwner {
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addProvider(address provider) external onlyOwner {
        isProvider[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        delete isProvider[provider];
        emit ProviderRemoved(provider);
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            paused = true;
            emit Paused(msg.sender);
        } else {
            paused = false;
            emit Unpaused(msg.sender);
        }
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        emit CooldownSecondsSet(cooldownSeconds, _cooldownSeconds);
        cooldownSeconds = _cooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (batches[currentBatchId].open) revert BatchOpen();
        currentBatchId++;
        Batch storage newBatch = batches[currentBatchId];
        newBatch.id = currentBatchId;
        newBatch.open = true;
        newBatch.dataCount = 0;
        newBatch.encryptedTotalVibration = FHE.asEuint32(0);
        newBatch.encryptedMaxTemperature = FHE.asEuint32(0);
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!batches[currentBatchId].open) revert BatchNotOpen();
        batches[currentBatchId].open = false;
        emit BatchClosed(currentBatchId);
    }

    function submitData(
        euint32 encryptedVibration,
        euint32 encryptedTemperature
    ) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime[msg.sender], "submission") {
        if (!batches[currentBatchId].open) revert BatchNotOpen();
        _initIfNeeded(encryptedVibration);
        _initIfNeeded(encryptedTemperature);

        Batch storage currentBatch = batches[currentBatchId];
        currentBatch.dataCount++;

        currentBatch.encryptedTotalVibration = FHE.add(currentBatch.encryptedTotalVibration, encryptedVibration);
        ebool isGreater = FHE.ge(encryptedTemperature, currentBatch.encryptedMaxTemperature);
        currentBatch.encryptedMaxTemperature = FHE.select(currentBatch.encryptedMaxTemperature, encryptedTemperature, isGreater);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit DataSubmitted(msg.sender, currentBatchId, currentBatch.dataCount);
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused respectCooldown(msg.sender, lastDecryptionRequestTime[msg.sender], "decryption_request") {
        if (batchId == 0 || batchId > currentBatchId || batches[batchId].open) revert InvalidBatch();

        euint32 memory totalVibration = batches[batchId].encryptedTotalVibration;
        euint32 memory maxTemperature = batches[batchId].encryptedMaxTemperature;

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalVibration);
        cts[1] = FHE.toBytes32(maxTemperature);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        // Security: Replay protection ensures this callback is processed only once for a given requestId.

        uint256 batchId = decryptionContexts[requestId].batchId;
        if (batchId == 0 || batchId > currentBatchId) revert InvalidBatch();

        euint32 memory totalVibration = batches[batchId].encryptedTotalVibration;
        euint32 memory maxTemperature = batches[batchId].encryptedMaxTemperature;

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = FHE.toBytes32(totalVibration);
        cts[1] = FHE.toBytes32(maxTemperature);

        bytes32 currentHash = _hashCiphertexts(cts);
        // Security: State verification ensures that the ciphertexts corresponding to the decryption request
        // have not changed since the request was made. This prevents scenarios where data is modified
        // after a decryption request but before the callback is processed.
        if (currentHash != decryptionContexts[requestId].stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert DecryptionFailed();

        (uint32 totalVibrationCleartext, uint32 maxTemperatureCleartext) = abi.decode(cleartexts, (uint32, uint32));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, batchId, totalVibrationCleartext, maxTemperatureCleartext);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 cipher) internal {
        if (!FHE.isInitialized(cipher)) {
            FHE.init(cipher);
        }
    }

    function _requireInitialized(euint32 cipher) internal view {
        if (!FHE.isInitialized(cipher)) {
            revert("Ciphertext not initialized");
        }
    }
}