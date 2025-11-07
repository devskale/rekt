rekt



setup:
python -m venv .venv 
source .venv/bin/activate
pip install -r requirements.txt

python python_fetch_group.py


reads telegram groups (portfolios)



Prerequisites
1. Get Telegram API credentials
Go to https://my.telegram.org/apps
Log in with your Telegram account
Create a new application (fill in App title, Short name)
Note down:
API ID (integer)
API Hash (string)
