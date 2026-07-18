import os
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

merge(1430)