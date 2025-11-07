import asyncio
import os

from dotenv import load_dotenv
from telethon import TelegramClient

load_dotenv()

api_id = os.getenv("API_ID")
if not api_id:
    raise ValueError("API_ID not set in environment variables")
API_ID = int(api_id)

api_hash = os.getenv("API_HASH")
if not api_hash:
    raise ValueError("API_HASH not set in environment variables")
API_HASH = api_hash

PHONE = os.getenv("PHONE_NUMBER")

# Replace with your target group
# Public group: use username without @, e.g., 'durov'
# Private group: use integer chat ID, e.g., -1001234567890
GROUP_IDENTIFIER = "mad_apes"  # 👈 CHANGE THIS TO YOUR TEST GROUP

client = TelegramClient("test_session", API_ID, API_HASH)


async def main():
    async with client:
        if PHONE:
            await client.start(phone=PHONE)
        else:
            await client.start()
        print("Client started.")

        try:
            # Get the group entity
            group = await client.get_entity(GROUP_IDENTIFIER)
            print(f"Fetching latest 20 messages from: {group.title} (ID: {group.id})")
        except Exception as e:
            print(f"Error fetching group: {e}")
            return

        # Fetch last 20 messages (newest first)
        messages = await client.get_messages(group, limit=20)

        print(f"\n--- Latest {len(messages)} messages ---\n")
        for msg in messages:
            if not msg.text:
                text = "[Media/Other]"
            else:
                text = msg.text[:100].replace("\n", " ") + (
                    "..." if len(msg.text) > 100 else ""
                )

            sender = "Unknown"
            if msg.sender:
                sender = (
                    getattr(msg.sender, "first_name", None)
                    or getattr(msg.sender, "title", None)
                    or getattr(msg.sender, "username", None)
                    or "Unknown"
                )

            print(f"[{msg.date.strftime('%Y-%m-%d %H:%M')}] {sender}: {text}")

        print("\nDone.")


# Run
asyncio.run(main())
