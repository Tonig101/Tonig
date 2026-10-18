def str_ord(s):
    if s.isupper():
        m = 'uppercase'
    elif s.islower():
        m = 'lowercase'
    elif s.isdigit():
        m = 'digital'
    else:
        m = 'other'
    return ord(s), hex(ord(s)).upper()[2:]+'H', m

num = input()
print(f'{str_ord(num)[0]} {str_ord(num)[1]} {str_ord(num)[2]}')
