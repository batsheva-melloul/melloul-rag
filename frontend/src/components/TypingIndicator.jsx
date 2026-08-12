// Animated "..." shown while waiting for the bot's answer.

function TypingIndicator() {
  return (
    <div className="message-row bot">
      <div className="avatar">🤖</div>
      <div className="bubble typing">
        <span className="dot" />
        <span className="dot" />
        <span className="dot" />
      </div>
    </div>
  );
}

export default TypingIndicator;