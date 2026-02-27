from redis import Redis
from rq import Queue
from tasks import say_hello  # import từ module, KHÔNG định nghĩa trong file này

# ❗ KHÔNG dùng decode_responses với RQ
r = Redis(host="127.0.0.1", port=6379)
q = Queue("design", connection=r)

job = q.enqueue(say_hello, "BK Team")
print("Job ID:", job.get_id())
