from rq import Queue
from rq import SimpleWorker  # ✅ dùng SimpleWorker thay cho Worker
from redis import Redis
import os
import sys

LISTEN = ['design']

REDIS_HOST = os.getenv('REDIS_HOST', '127.0.0.1')
REDIS_PORT = int(os.getenv('REDIS_PORT', '6379'))
REDIS_PASSWORD = os.getenv('REDIS_PASSWORD')  # None nếu không đặt pass

# ❗KHÔNG dùng decode_responses với RQ
redis_conn = Redis(host=REDIS_HOST, port=REDIS_PORT, password=REDIS_PASSWORD)

if __name__ == '__main__':
    queues = [Queue(name, connection=redis_conn) for name in LISTEN]

    # Gợi ý: cảnh báo nếu đang chạy trên Windows bằng Prefork
    if os.name == 'nt':
        print("Windows detected -> using SimpleWorker (no fork).", file=sys.stderr)

    worker = SimpleWorker(queues, connection=redis_conn)
    # with_scheduler không cần ở đây; nếu cần schedule, chạy rqscheduler riêng.
    worker.work(with_scheduler=False)
