// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract Shielded {
    address public relayer;
    address public owner;

    // token => user => encrypted balance blob
    mapping(address => mapping(address => bytes)) private encryptedBalances;
    // token => user => raw amount held by contract
    mapping(address => mapping(address => uint256)) public totalDeposited;

    // ECDH P-256 public key registry (65-byte uncompressed point)
    mapping(address => bytes) public ecdhPublicKeys;

    // token => receiver => pending deposit payloads
    // Each payload: ephemeralPubKey (65 bytes) | AES-GCM ciphertext of amount
    mapping(address => mapping(address => bytes[])) private pendingDeposits;

    // address(0) = native INJ
    address public constant NATIVE = address(0);

    event Deposit(address indexed user, address indexed token);
    event Withdraw(address indexed user);            // token intentionally hidden
    event BalancesUpdated(address indexed relayer, address indexed token, uint256 count);
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);
    event PublicKeyRegistered(address indexed user);
    event PendingDepositStored(bytes32 indexed tag); // hides token, sender, receiver

    modifier onlyRelayer() {
        require(msg.sender == relayer, "Shielded: not relayer");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Shielded: not owner");
        _;
    }

    constructor(address _relayer) {
        require(_relayer != address(0), "Shielded: zero relayer");
        relayer = _relayer;
        owner = msg.sender;
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    /// @notice Shield tokens into the encrypted pool.
    /// @param token  address(0) = native INJ, otherwise ERC-20 contract address
    /// @param amount Token amount (must equal msg.value for native; ignored for native otherwise)
    function deposit(
        address token,
        uint256 amount,
        bytes calldata encryptedBalance
    ) external payable {
        require(encryptedBalance.length > 0, "Shielded: empty payload");

        if (token == NATIVE) {
            require(msg.value > 0, "Shielded: no INJ sent");
            totalDeposited[NATIVE][msg.sender] += msg.value;
        } else {
            require(msg.value == 0, "Shielded: ETH with token deposit");
            require(amount > 0, "Shielded: zero amount");
            bool ok = IERC20(token).transferFrom(msg.sender, address(this), amount);
            require(ok, "Shielded: transferFrom failed");
            totalDeposited[token][msg.sender] += amount;
        }

        encryptedBalances[token][msg.sender] = encryptedBalance;
        emit Deposit(msg.sender, token);
    }

    // ── Withdraw ──────────────────────────────────────────────────────────────

    /// @notice Unshield tokens back to the caller's wallet.
    function withdraw(
        address token,
        uint256 amount,
        bytes calldata newEncryptedBalance
    ) external {
        require(totalDeposited[token][msg.sender] >= amount, "Shielded: insufficient");
        totalDeposited[token][msg.sender] -= amount;

        if (newEncryptedBalance.length > 0) {
            encryptedBalances[token][msg.sender] = newEncryptedBalance;
        } else {
            delete encryptedBalances[token][msg.sender];
        }

        emit Withdraw(msg.sender); // token not emitted — intentional

        if (token == NATIVE) {
            (bool ok,) = msg.sender.call{value: amount}("");
            require(ok, "Shielded: INJ transfer failed");
        } else {
            bool ok = IERC20(token).transfer(msg.sender, amount);
            require(ok, "Shielded: token transfer failed");
        }
    }

    // ── ECDH public key ───────────────────────────────────────────────────────

    function registerPublicKey(bytes calldata pubKey) external {
        require(pubKey.length == 65, "Shielded: pubKey must be 65 bytes");
        ecdhPublicKeys[msg.sender] = pubKey;
        emit PublicKeyRegistered(msg.sender);
    }

    function getPublicKey(address user) external view returns (bytes memory) {
        return ecdhPublicKeys[user];
    }

    // ── Pending deposits (private P2P transfers) ──────────────────────────────

    function storePendingDeposit(
        address token,
        address receiver,
        bytes calldata payload
    ) external {
        require(payload.length > 65, "Shielded: payload too short");
        pendingDeposits[token][receiver].push(payload);
        bytes32 tag = keccak256(
            abi.encodePacked(token, receiver, pendingDeposits[token][receiver].length)
        );
        emit PendingDepositStored(tag);
    }

    function getPendingDeposits(
        address token,
        address user
    ) external view returns (bytes[] memory) {
        return pendingDeposits[token][user];
    }

    function clearPendingDeposits(address token) external {
        delete pendingDeposits[token][msg.sender];
    }

    // ── Relayer batch update ───────────────────────────────────────────────────

    function updateBalances(
        address token,
        address[] calldata users,
        bytes[] calldata balances
    ) external onlyRelayer {
        require(users.length == balances.length, "Shielded: length mismatch");
        require(users.length > 0, "Shielded: empty arrays");
        for (uint256 i = 0; i < users.length; i++) {
            require(balances[i].length > 0, "Shielded: empty balance");
            encryptedBalances[token][users[i]] = balances[i];
        }
        emit BalancesUpdated(msg.sender, token, users.length);
    }

    /// @notice Self-relay fallback — user updates only their own encrypted balance.
    ///         Used when the relayer server is offline. User pays gas themselves.
    function selfUpdateBalance(
        address token,
        bytes calldata newEncryptedBalance
    ) external {
        require(newEncryptedBalance.length > 0, "Shielded: empty balance");
        encryptedBalances[token][msg.sender] = newEncryptedBalance;
        address[] memory u = new address[](1);
        u[0] = msg.sender;
        emit BalancesUpdated(msg.sender, token, 1);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function getEncryptedBalance(
        address token,
        address user
    ) external view returns (bytes memory) {
        return encryptedBalances[token][user];
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    function setRelayer(address _newRelayer) external onlyOwner {
        require(_newRelayer != address(0), "Shielded: zero address");
        address old = relayer;
        relayer = _newRelayer;
        emit RelayerUpdated(old, _newRelayer);
    }
}
