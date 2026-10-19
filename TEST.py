def f(min,max):
    a = 0
    b = 1
    num_list = []
    while a <= max:
        if a >= min:
            num_list.append(a)
        a, b = b, a + b
    return num_list

min,max = map(int,input().split())
print(*f(min,max),sep=' ')


