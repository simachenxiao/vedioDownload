import requests
import os
import m3u8
from multiprocessing.dummy import Pool
from tqdm import tqdm
from retry import retry
from urllib.parse import urljoin

@retry(tries=10, delay=2) # 重试3次, 间隔2s
def download(i, url):
    if os.path.exists(f"./{i}.ts"):
        pass
    else:
        res = requests.get(url,stream=True)
        with open(f"./{i}.ts", "wb") as f:
            f.write(res.content)

def merge(total):
    print("\n开始合并视频")
    with open("./test.mp4", "ab") as f:
        for i in range(total):
            try:
                path = f"./{i}.ts"
                content = open(path, "rb").read()
                f.write(content)
                os.remove(path)
            except Exception as e:
                print(e)

#url =input("请输入m3u8地址\n")https://v.fengbao8.com/video/tangchaoguishiluzhichangan/%E7%AC%AC12%E9%9B%86/index.m3u8
url="https://cdn4.ryplay4.com/20240801/94_c9c8d7b1/2000k/hls/index.m3u8"
base="https://cdn4.ryplay4.com/20240801/94_c9c8d7b1/2000k/hls/"
m3u8_data = m3u8.load(url).data
print(m3u8_data)

ts_list = []
for i in range(len(m3u8_data["segments"])):
    ts_list.append(urljoin(base, m3u8_data["segments"][i]["uri"]))
total = len(ts_list)-1

pbar = tqdm(total=total)
pbar.set_description("进度条")
update = lambda *args: pbar.update()

if __name__ == "__main__":
    pool = Pool(64)
    for i in range(total):
        if not os.path.exists(f"./{i}.ts"):
            pool.apply_async(download, args=(i, ts_list[i],), callback=update)
    pool.close()
    pool.join()  # 阻塞主线程
    
#    merge(total)
